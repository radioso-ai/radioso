import type { Kysely } from "kysely";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { AppLogger } from "../observability/logger.js";
import { createKyselyDatabase } from "./kysely/kyselyDatabase.js";
import type { DB } from "./kysely/schema.js";

interface DatabaseOptions {
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  applicationName?: string;
  /** Receives a warning when the server ends a connection that is idle in the pool. */
  logger?: Pick<AppLogger, "warn">;
}

interface IdleConnectionLoss {
  applicationName?: string;
  code?: string;
  // Named `postgresSeverity`, not `severity`: the Pino logger already writes a top-level
  // `severity` for Cloud Logging (e.g. "WARNING"). A same-named field here would collide
  // with it in the serialized JSON, and a consumer could read Postgres's "FATAL" where the
  // logger meant a handled warning.
  postgresSeverity?: string;
}

// Only named fields leave the error: pg-pool attaches the lost client, whose connection
// parameters carry the password, and a server message can quote a value. The SQLSTATE and
// severity say why the connection ended.
const describeIdleConnectionLoss = (error: Error, applicationName?: string): IdleConnectionLoss => {
  const { code, severity } = error as Error & { code?: unknown; severity?: unknown };
  return {
    applicationName,
    code: typeof code === "string" ? code : undefined,
    postgresSeverity: typeof severity === "string" ? severity : undefined,
  };
};

export class Database {
  readonly pool: Pool;
  #kysely?: Kysely<DB>;

  constructor(connectionString: string, options: DatabaseOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: options.poolMax,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      lock_timeout: options.lockTimeoutMs,
      statement_timeout: options.statementTimeoutMs,
      query_timeout: options.queryTimeoutMs,
      application_name: options.applicationName,
      keepAlive: true,
    });
    // A failover, restart, idle-session timeout, or pg_terminate_backend ends idle pooled
    // connections. pg-pool has already discarded the client when it emits this, and the next
    // query opens a fresh connection; an 'error' event with no listener would instead be
    // thrown as an uncaught exception and take the process down.
    this.pool.on("error", (error) => {
      options.logger?.warn(describeIdleConnectionLoss(error, options.applicationName), "database_idle_connection_lost");
    });

    // pg-pool only guards *idle* clients: it detaches its own error listener the instant a
    // client is checked out (the "acquire" event) and reattaches one on release. A
    // server-side termination that lands while a client is checked out with no query in
    // flight — withTransaction below, a Kysely transaction, or a lock client held across
    // migrations — would otherwise emit 'error' on a listener-less client and crash the
    // process the same way an unguarded idle client would. The checked-out owner still sees
    // the failure on its next query (the client becomes unqueryable); this only stops the
    // crash. One stable handler reference, attached on every acquire and removed on every
    // release, so the listener count never grows across repeated checkouts of the same client.
    const onCheckedOutClientError = (error: Error): void => {
      options.logger?.warn(
        describeIdleConnectionLoss(error, options.applicationName),
        "database_checked_out_connection_lost",
      );
    };
    this.pool.on("acquire", (client) => {
      client.on("error", onCheckedOutClientError);
    });
    this.pool.on("release", (_error, client) => {
      client.removeListener("error", onCheckedOutClientError);
    });
  }

  /**
   * Kysely query builder over the same pool. Repositories migrated off raw SQL are
   * injected this (typed `Db`); it shares the pool and transaction context with the raw
   * `query*` methods during the migration. Lazily created; closed via {@link close}.
   */
  get kysely(): Kysely<DB> {
    if (!this.#kysely) {
      this.#kysely = createKyselyDatabase(this.pool);
    }

    return this.#kysely;
  }

  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query<T>(text, params);
    return result.rows;
  }

  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const row = await this.queryOptional<T>(text, params);
    if (!row) {
      throw new Error("Expected query to return one row");
    }

    return row;
  }

  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(text, params);
    return result.rowCount ?? 0;
  }

  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
