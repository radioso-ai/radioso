import { describe, expect, it, vi } from "vitest";

import { skillSubmissionMigrator } from "./skillSubmissionMigrator.js";

describe("skillSubmissionMigrator", () => {
  it("owns generic skill submission table creation", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await skillSubmissionMigrator.migrate(database);

    expect(queries.join("\n")).toContain("CREATE TABLE IF NOT EXISTS skill_submissions");
    expect(queries.join("\n")).toContain("fields JSONB NOT NULL");
    expect(queries.join("\n")).toContain("ALTER COLUMN fields DROP DEFAULT");
    expect(queries.join("\n")).not.toContain("fields JSONB NOT NULL DEFAULT '{}'::jsonb");
  });

  it("repairs the legacy idempotency index before recreating it", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await skillSubmissionMigrator.migrate(database);

    const repairIndexQuery = queries.find((query) => query.includes("skill_submissions_idempotency_key_idx") &&
      query.includes("current_index_definition"));
    const createIndexQuery = queries.find((query) =>
      query.includes("CREATE UNIQUE INDEX IF NOT EXISTS skill_submissions_idempotency_key_idx")
    );

    expect(repairIndexQuery).toContain("DROP INDEX skill_submissions_idempotency_key_idx");
    expect(repairIndexQuery).toContain("(workspace_id, skill_name, idempotency_key)");
    expect(createIndexQuery).toContain("ON skill_submissions (workspace_id, skill_name, idempotency_key)");
    expect(queries.indexOf(repairIndexQuery ?? "")).toBeLessThan(queries.indexOf(createIndexQuery ?? ""));
  });

  it("uses pending-only due delivery and workspace-scoped subject identity indexes", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [];
      }),
    };

    await skillSubmissionMigrator.migrate(database);

    const dueRepairQuery = queries.find((query) =>
      query.includes("skill_submissions_due_idx") && query.includes("current_index_definition")
    );
    const dueIndexQuery = queries.find((query) =>
      query.includes("CREATE INDEX IF NOT EXISTS skill_submissions_due_idx")
    );
    const subjectRepairQuery = queries.find((query) =>
      query.includes("skill_submissions_subject_identity_idx") && query.includes("current_index_definition")
    );
    const subjectIndexQuery = queries.find((query) =>
      query.includes("CREATE INDEX IF NOT EXISTS skill_submissions_subject_identity_idx")
    );

    expect(dueRepairQuery).toContain("DROP INDEX skill_submissions_due_idx");
    expect(dueIndexQuery).toContain("ON skill_submissions (next_retry_at, created_at)");
    expect(dueIndexQuery).toContain("WHERE status = 'pending'");
    expect(subjectRepairQuery).toContain("DROP INDEX skill_submissions_subject_identity_idx");
    expect(subjectIndexQuery).toContain("ON skill_submissions (workspace_id, subject_identity)");
    expect(subjectIndexQuery).toContain("WHERE subject_identity IS NOT NULL");
  });
});
