import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../src/db/migrations/166_topic_transitions_run_topic_unique.sql",
  import.meta.url,
);

describe("topic transition uniqueness migration", () => {
  it("bounds and excludes live writers across deduplication and index creation", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    const lockTimeout = sql.search(/SET LOCAL lock_timeout\s*=/i);
    const statementTimeout = sql.search(/SET LOCAL statement_timeout\s*=/i);
    const writerLock = sql.search(/LOCK TABLE topic_transitions IN SHARE ROW EXCLUSIVE MODE/i);
    const cleanup = sql.search(/DELETE FROM topic_transitions/i);
    const index = sql.search(/CREATE UNIQUE INDEX/i);

    expect(lockTimeout).toBeGreaterThanOrEqual(0);
    expect(statementTimeout).toBeGreaterThanOrEqual(0);
    expect(writerLock).toBeGreaterThan(statementTimeout);
    expect(cleanup).toBeGreaterThan(writerLock);
    expect(index).toBeGreaterThan(cleanup);
    expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY/i);
  });

  it("prefers a non-dissolved correction before falling back to chronological order", async () => {
    const sql = await readFile(migrationUrl, "utf8");

    expect(sql).toMatch(/kind\s*=\s*'dissolved'/i);
    expect(sql).toMatch(/created_at/i);
    expect(sql).toMatch(/\bid\b/i);
  });
});
