import type { Kysely } from "kysely";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import { createKyselyDatabase } from "./kysely/kyselyDatabase.js";
import type { DB } from "./kysely/schema.js";

export interface DatabaseExecutor {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  queryOptional<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
  queryOne<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T>;
  execute(text: string, params?: unknown[]): Promise<number>;
}

export interface DatabaseOptions {
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  applicationName?: string;
}

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

export const databaseExecutorFromClient = (client: Pick<PoolClient, "query">): DatabaseExecutor => ({
  async query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const result = await client.query<T>(text, params);
    return result.rows;
  },

  async queryOptional<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T | null> {
    const result = await client.query<T>(text, params);
    return result.rows[0] ?? null;
  },

  async queryOne<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T> {
    const result = await client.query<T>(text, params);
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected query to return one row");
    }
    return row;
  },

  async execute(text: string, params: unknown[] = []): Promise<number> {
    const result = await client.query(text, params);
    return result.rowCount ?? 0;
  },
});
