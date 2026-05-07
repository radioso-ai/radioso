import { Pool, type PoolClient, type QueryResultRow } from "pg";

export interface DatabaseOptions {
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  applicationName?: string;
}

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string, options: DatabaseOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: options.poolMax,
      idleTimeoutMillis: options.idleTimeoutMs,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      statement_timeout: options.statementTimeoutMs,
      query_timeout: options.queryTimeoutMs,
      application_name: options.applicationName,
      keepAlive: true,
    });
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
