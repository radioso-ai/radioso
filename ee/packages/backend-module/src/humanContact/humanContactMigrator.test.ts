import { describe, expect, it, vi } from "vitest";

import { humanContactMigrator } from "./humanContactMigrator.js";

describe("humanContactMigrator", () => {
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
