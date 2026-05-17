import { describe, expect, it, vi } from "vitest";

import { humanContactMigrator } from "./humanContactMigrator.js";

describe("humanContactMigrator", () => {
  it("repairs the legacy skill submission idempotency index before recreating it", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await humanContactMigrator.migrate(database);

    const repairIndexQuery = queries.find((query) => query.includes("current_index_definition"));
    const createIndexQuery = queries.find((query) =>
      query.includes("CREATE UNIQUE INDEX IF NOT EXISTS skill_submissions_idempotency_key_idx")
    );

    expect(repairIndexQuery).toContain("DROP INDEX skill_submissions_idempotency_key_idx");
    expect(repairIndexQuery).toContain("(workspace_id, skill_name, idempotency_key)");
    expect(createIndexQuery).toContain("ON skill_submissions (workspace_id, skill_name, idempotency_key)");
    expect(queries.indexOf(repairIndexQuery ?? "")).toBeLessThan(queries.indexOf(createIndexQuery ?? ""));
  });

  it("repairs older contact request tables before migrating them into skill submissions", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await humanContactMigrator.migrate(database);

    const migrationQuery = queries.find((query) => query.includes("FROM ee_contact_requests"));

    expect(migrationQuery).toContain("ADD COLUMN IF NOT EXISTS idempotency_key TEXT");
    expect(migrationQuery).toContain("ADD COLUMN IF NOT EXISTS activity_trace JSONB");
    expect(migrationQuery?.indexOf("ADD COLUMN IF NOT EXISTS idempotency_key TEXT")).toBeLessThan(
      migrationQuery?.indexOf("INSERT INTO skill_submissions") ?? -1,
    );
  });
});
