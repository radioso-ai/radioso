import { describe, expect, it } from "vitest";

import { HnswIterativeScanRunner } from "../../../src/modules/retrieval/infra/hnswIterativeScan.js";
import type { Database } from "../../../src/shared/infra/database.js";

const undefinedObject = (message: string): Error =>
  Object.assign(new Error(message), { code: "42704" });

const unsupportedGuc = () =>
  undefinedObject('unrecognized configuration parameter "hnsw.iterative_scan"');

interface Recorded {
  readonly transactions: string[][];
  readonly direct: string[];
}

/**
 * Stands in for the pg pool. `failSet` models a server without the setting; `failQuery`
 * models the search itself failing once the setting has been accepted.
 */
const databaseStub = (input: {
  failSet?: unknown | ((sql: string) => unknown);
  failQuery?: unknown;
  rows?: Record<string, unknown>[];
}): { database: Database; recorded: Recorded } => {
  const recorded: Recorded = { transactions: [], direct: [] };
  const database = {
    async withTransaction(callback: (client: {
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    }) => Promise<unknown>) {
      const statements: string[] = [];
      recorded.transactions.push(statements);
      return callback({
        async query(sql: string) {
          statements.push(sql);
          if (sql.startsWith("SET LOCAL")) {
            const failure = typeof input.failSet === "function"
              ? input.failSet(sql)
              : input.failSet;
            if (failure) {
              throw failure;
            }
            return { rows: [] };
          }
          if (input.failQuery) {
            throw input.failQuery;
          }
          return { rows: input.rows ?? [] };
        },
      });
    },
    async query(sql: string) {
      recorded.direct.push(sql);
      return input.rows ?? [];
    },
  } as unknown as Database;
  return { database, recorded };
};

describe("HnswIterativeScanRunner", () => {
  it("uses the high-recall HNSW search breadth before strict-order scanning", async () => {
    const { database, recorded } = databaseStub({ rows: [{ chunk_id: "chunk-1" }] });

    const rows = await new HnswIterativeScanRunner(database).run("SELECT 1", []);

    expect(recorded.transactions).toEqual([[
      "SET LOCAL hnsw.ef_search = 1000",
      "SET LOCAL hnsw.max_scan_tuples = 20000",
      "SET LOCAL hnsw.iterative_scan = strict_order",
      "SELECT 1",
    ]]);
    expect(rows).toEqual([{ chunk_id: "chunk-1" }]);
  });

  it("falls back to a plain query when the server has no iterative scan", async () => {
    const { database, recorded } = databaseStub({
      failSet: (sql: string) => sql.includes("hnsw.iterative_scan") ? unsupportedGuc() : undefined,
    });

    await new HnswIterativeScanRunner(database).run("SELECT 1", []);

    expect(recorded.transactions).toEqual([[
      "SET LOCAL hnsw.ef_search = 1000",
      "SET LOCAL hnsw.max_scan_tuples = 20000",
      "SET LOCAL hnsw.iterative_scan = strict_order",
    ]]);
    expect(recorded.direct).toEqual(["SELECT 1"]);
  });

  // The probe costs a pooled client and an aborted transaction. Repeating it on every
  // search would make an older server pay that on every retrieval turn forever.
  it("probes support once and reuses the answer", async () => {
    const { database, recorded } = databaseStub({
      failSet: (sql: string) => sql.includes("hnsw.iterative_scan") ? unsupportedGuc() : undefined,
    });
    const runner = new HnswIterativeScanRunner(database);

    await runner.run("SELECT 1", []);
    await runner.run("SELECT 2", []);
    await runner.run("SELECT 3", []);

    expect(recorded.transactions).toHaveLength(1);
    expect(recorded.direct).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  // lc_messages is a per-server setting, so the English message is not something a
  // production server is obliged to produce. The SQLSTATE is.
  it("recognises the unsupported parameter from its SQLSTATE, not its message text", async () => {
    const { database, recorded } = databaseStub({
      failSet: (sql: string) => sql.includes("hnsw.iterative_scan")
        ? undefinedObject("nicht erkannter Konfigurationsparameter »hnsw.iterative_scan«")
        : undefined,
    });

    await new HnswIterativeScanRunner(database).run("SELECT 1", []);

    expect(recorded.direct).toEqual(["SELECT 1"]);
  });

  // A cast to a vector type the installed pgvector does not define raises the same
  // SQLSTATE as a missing setting. Treating it as a missing setting would retry a
  // doomed query and then disable iterative scanning for the life of the process.
  it("does not read an undefined_object from the query itself as a missing setting", async () => {
    const { database, recorded } = databaseStub({
      failQuery: undefinedObject('type "halfvec" does not exist'),
    });
    const runner = new HnswIterativeScanRunner(database);

    await expect(runner.run("SELECT 1", [])).rejects.toThrow("halfvec");
    expect(recorded.direct).toEqual([]);

    // The next search still tries the setting rather than staying on the fallback.
    await runner.run("SELECT 2", []).catch(() => undefined);
    expect(recorded.transactions).toHaveLength(2);
  });

  it("rethrows failures that are not about iterative scan support", async () => {
    const { database, recorded } = databaseStub({
      failSet: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    });

    await expect(new HnswIterativeScanRunner(database).run("SELECT 1", []))
      .rejects.toThrow("deadlock detected");
    expect(recorded.direct).toEqual([]);
  });

  // Retrying outside the transaction would run a timing-out search twice per turn.
  it("does not retry a query that failed inside a supported transaction", async () => {
    const { database, recorded } = databaseStub({
      failQuery: Object.assign(
        new Error("canceling statement due to statement timeout"),
        { code: "57014" },
      ),
    });

    await expect(new HnswIterativeScanRunner(database).run("SELECT 1", []))
      .rejects.toThrow("statement timeout");
    expect(recorded.direct).toEqual([]);
  });
});
