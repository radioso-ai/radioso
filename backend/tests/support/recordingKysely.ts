import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";

import type { DB } from "../../src/shared/infra/kysely/types.js";

/** A statement the database received, with the transaction it ran in; null outside one. */
export interface RecordedStatement {
  sql: string;
  parameters: readonly unknown[];
  transaction: number | null;
}

/** What the database answers a statement with: its rows, and for a write without RETURNING how many it changed. */
export type RecordedAnswer = { rows?: Record<string, unknown>[]; changed?: number } | undefined;

/**
 * A real Kysely over Postgres SQL whose driver answers from `answer` instead of a server, and
 * records every statement with the transaction it ran in and every BEGIN, COMMIT and ROLLBACK in
 * `log`, so a test can assert what a unit of work sent, in what order and in which transaction,
 * without Postgres. Statements `answer` does not recognise return no rows.
 */
export const createRecordingKysely = (answer: (statement: { sql: string; parameters: readonly unknown[] }) => RecordedAnswer) => {
  const statements: RecordedStatement[] = [];
  const log: string[] = [];
  let transactions = 0;
  let transaction: number | null = null;
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      statements.push({ sql: compiled.sql, parameters: compiled.parameters, transaction });
      log.push(compiled.sql);
      const answered = answer({ sql: compiled.sql, parameters: compiled.parameters });
      const rows = (answered?.rows ?? []) as R[];
      return { rows, numAffectedRows: BigInt(answered?.changed ?? rows.length) };
    },
    streamQuery() {
      throw new Error("streamQuery is not recorded");
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => {
      transactions += 1;
      transaction = transactions;
      log.push("BEGIN");
    },
    commitTransaction: async () => {
      log.push("COMMIT");
      transaction = null;
    },
    rollbackTransaction: async () => {
      log.push("ROLLBACK");
      transaction = null;
    },
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements, log };
};
