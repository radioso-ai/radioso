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
    expect(migrationQuery).toContain("SQL migrations cannot import TS constants");
    expect(migrationQuery).toContain("existing.skill_name = 'human_contact.request'");
    expect(migrationQuery).toContain("existing.idempotency_key = ee_contact_requests.idempotency_key");
    expect(migrationQuery).not.toContain("ON CONFLICT (id) DO NOTHING");
    expect(migrationQuery?.indexOf("ADD COLUMN IF NOT EXISTS idempotency_key TEXT")).toBeLessThan(
      migrationQuery?.indexOf("INSERT INTO skill_submissions") ?? -1,
    );
  });

  it("does not own generic skill submissions table infrastructure", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await humanContactMigrator.migrate(database);

    expect(queries.join("\n")).not.toContain("CREATE TABLE IF NOT EXISTS skill_submissions");
    expect(queries.join("\n")).not.toContain("CREATE UNIQUE INDEX IF NOT EXISTS skill_submissions_idempotency_key_idx");
  });
});
