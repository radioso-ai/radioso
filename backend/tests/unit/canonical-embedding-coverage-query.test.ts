import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { DocumentProcessingJobRepository } from "../../src/db/repositories/documentProcessingJobRepository.js";
import type { DB } from "../../src/shared/infra/kysely/schema.js";

describe("canonical embedding coverage query", () => {
  it("scopes blocking-job work inside the materialized per-workspace CTE", async () => {
    const workspaceId = "11111111-1111-1111-1111-111111111111";
    let compiledQuery: { sql: string; parameters: readonly unknown[] } | undefined;
    const client = {
      async query(sql: string, parameters: readonly unknown[]) {
        compiledQuery = { sql, parameters };
        return {
          command: "SELECT",
          rows: [{
            eligible_chunks: "0",
            missing_chunks: "0",
            has_embedding_profile: false,
            queued_jobs: "0",
            failed_jobs: "0",
          }],
        };
      },
      release() {},
    };
    const db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: {
          async connect() {
            return client;
          },
          async end() {},
        } as unknown as Pool,
      }),
    });
    const repository = new DocumentProcessingJobRepository(db);

    try {
      await repository.getWorkspaceCanonicalEmbeddingCoverage(workspaceId);
    } finally {
      await db.destroy();
    }

    const querySql = compiledQuery?.sql ?? "";
    const currentJobsStart = querySql.indexOf("current_gap_jobs AS (");
    const coverageStart = querySql.indexOf("coverage AS (");
    const currentJobsSql = querySql.slice(currentJobsStart, coverageStart);

    expect(currentJobsStart).toBeGreaterThan(-1);
    expect(coverageStart).toBeGreaterThan(currentJobsStart);
    expect(currentJobsSql).toMatch(/j\.workspace_id\s*=\s*\$\d+/);
    expect(compiledQuery?.parameters).toContain(workspaceId);
  });
});
