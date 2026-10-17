import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationsDirectory = new URL("../../src/db/migrations/", import.meta.url);

/** The SQL a migration runs, with comments stripped. */
const statementsOf = (source: string): string =>
  source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const keyMigrations = async (): Promise<{ file: string; sql: string }[]> => {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^228_conversation_erasure_.*\.sql$/u.test(file)).sort();
  return Promise.all(files.map(async (file) => ({
    file,
    sql: statementsOf(await readFile(new URL(file, migrationsDirectory), "utf8")),
  })));
};

/** Every table a migration takes a lock on: what it locks, indexes, alters, or writes. */
const tablesTouched = (sql: string): string[] => [
  ...sql.matchAll(/\b(?:LOCK TABLE|ON|ALTER TABLE|UPDATE|DELETE FROM|INSERT INTO)\s+([a-z_]+)/gu),
].map((match) => match[1]).filter((table, index, all) => all.indexOf(table) === index);

/**
 * Migrations run at API boot while the previous revision still serves, each file in one
 * transaction. The erasure keys go on tables live chat turns write, and two live writers take those
 * tables in opposite orders (a turn writes the outbox before its pending decision; resolving a
 * decision writes the decision first), so one file holding two of them could deadlock with either.
 */
describe("conversation erasure key migrations", () => {
  it("are split one table per file", async () => {
    const migrations = await keyMigrations();

    expect(migrations.length).toBeGreaterThanOrEqual(10);
    for (const { file, sql } of migrations) {
      expect({ file, tables: tablesTouched(sql) }).toEqual({ file, tables: [tablesTouched(sql)[0]] });
    }
  });

  it("bound every lock wait to three seconds, before taking any lock", async () => {
    for (const { file, sql } of await keyMigrations()) {
      expect({ file, first: sql.trim().split(";")[0].trim() }).toEqual({ file, first: "SET LOCAL lock_timeout = '3s'" });
    }
  });

  it("take their own table first and reach the table they reference last", async () => {
    for (const { file, sql } of await keyMigrations()) {
      const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean).slice(1);
      // Strong enough for every statement after it, so no lock is upgraded mid-file.
      expect({ file, lock: statements[0] }).toEqual({ file, lock: expect.stringMatching(/^LOCK TABLE [a-z_]+ IN (?:SHARE ROW|ACCESS) EXCLUSIVE MODE$/u) });
      if (/DROP NOT NULL/u.test(sql)) {
        expect({ file, lock: statements[0] }).toEqual({ file, lock: expect.stringMatching(/ACCESS EXCLUSIVE MODE$/u) });
      }
      const referencing = statements.findIndex((statement) => /\bREFERENCES\b/u.test(statement));
      if (referencing !== -1) {
        expect({ file, last: referencing }).toEqual({ file, last: statements.length - 1 });
      }
    }
  });

  it("leave row work to the validating migration, and build an index only if the runbook has not", async () => {
    for (const { file, sql } of await keyMigrations()) {
      expect({ file, rowWork: /\b(?:DELETE FROM|UPDATE|INSERT INTO)\b/u.test(sql) }).toEqual({ file, rowWork: false });
      for (const index of sql.matchAll(/CREATE (?:UNIQUE )?INDEX[^;]*/gu)) {
        expect({ file, index: index[0] }).toEqual({ file, index: expect.stringMatching(/^CREATE INDEX IF NOT EXISTS /u) });
      }
      // A key validated here would scan its table under the lock; 229 validates it under a lighter one.
      const keys = sql.match(/\bFOREIGN KEY\b/gu)?.length ?? 0;
      const unvalidated = sql.match(/\bNOT VALID\b/gu)?.length ?? 0;
      expect({ file, keys, unvalidated }).toEqual({ file, keys, unvalidated: keys });
    }
  });
});
