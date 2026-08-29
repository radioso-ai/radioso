import type { QueryResultRow } from "pg";

import type { Database } from "../../../shared/infra/database.js";

// Postgres reports an unknown GUC as undefined_object. Matching the SQLSTATE rather
// than the message keeps the probe working on a server whose lc_messages is not
// English, where the text would not match and the error would escape as a 500.
const UNDEFINED_OBJECT = "42704";
const HIGH_RECALL_EF_SEARCH = 1000;
const HIGH_RECALL_MAX_SCAN_TUPLES = 20_000;

// undefined_object is not unique to the GUC — a cast to a vector type the installed
// pgvector does not define raises it too. Marking the failure at the statement that
// caused it keeps a broken query from being read as a missing setting, which would
// otherwise disable the configured HNSW path for the life of the process.
const HNSW_SETTINGS_UNSUPPORTED = Symbol("hnsw settings unsupported");

/**
 * Runs a vector query with high-recall HNSW settings. Strict iterative scan lets a
 * search whose filters are applied after the index scan keep pulling neighbours
 * instead of returning short of its LIMIT.
 *
 * Strict iterative scan only exists in pgvector 0.8 and later, and `SET LOCAL` only
 * applies inside a transaction — which costs a pooled client plus BEGIN/COMMIT per
 * search. Support is a property of the installed extension, so it is probed once per
 * runner and remembered: an older server pays one aborted transaction on its first
 * search rather than on every one. Upgrading pgvector under a running process therefore
 * needs a restart before iterative scanning is picked up, which a deploy does anyway.
 */
export class HnswIterativeScanRunner {
  private supported: boolean | null = null;

  constructor(private readonly database: Database) {}

  async run<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
    if (this.supported === false) {
      return this.database.query<T>(sql, params);
    }

    try {
      const rows = await this.database.withTransaction(async (client) => {
        try {
          // Filtered workspace searches need considerably more candidates than the
          // pgvector default to preserve recall at the canonical HNSW boundary.
          // Keep this transaction-scoped so it cannot leak through the pool.
          await client.query(`SET LOCAL hnsw.ef_search = ${HIGH_RECALL_EF_SEARCH}`);
          await client.query(`SET LOCAL hnsw.max_scan_tuples = ${HIGH_RECALL_MAX_SCAN_TUPLES}`);
          await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
        } catch (error) {
          if (isHnswSettingUnsupported(error)) {
            throw HNSW_SETTINGS_UNSUPPORTED;
          }
          throw error;
        }
        const result = await client.query<T>(sql, params);
        return result.rows;
      });
      this.supported = true;
      return rows;
    } catch (error) {
      // Only a missing setting is retryable. A timeout, a deadlock or a bad filter
      // belongs to the query, and running it again would double its cost on the way
      // to the same error.
      if (error !== HNSW_SETTINGS_UNSUPPORTED) {
        throw error;
      }
      this.supported = false;
      return this.database.query<T>(sql, params);
    }
  }
}

export const isHnswSettingUnsupported = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && (error as { code?: unknown }).code === UNDEFINED_OBJECT;
