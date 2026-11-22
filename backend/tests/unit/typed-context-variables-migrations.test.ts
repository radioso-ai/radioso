import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationsDirectory = new URL("../../src/db/migrations/", import.meta.url);

/** A migration's statements, comments stripped and whitespace collapsed. */
const statementsOf = async (file: string): Promise<string[]> =>
  (await readFile(new URL(file, migrationsDirectory), "utf8"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.replaceAll(/\s+/gu, " ").trim())
    .filter(Boolean);

const catalogFile = "270_typed_context_variables.sql";
const scanFile = "271_typed_context_variables_validate_and_index.sql";

const namesMatching = (statements: string[], pattern: RegExp): string[] =>
  statements.flatMap((statement) => [...statement.matchAll(pattern)].map((match) => match[1])).sort();

/**
 * Every chat turn reads `context_variable_values`. 270 takes ACCESS EXCLUSIVE on both tables, which
 * every read waits for, so it holds that lock only for catalog changes; the scans run in 271, under
 * locks no read waits for, after 270 has committed and released its own.
 */
describe("typed context variable migrations", () => {
  it("bound 270's lock wait and run no scan under its exclusive lock", async () => {
    const statements = await statementsOf(catalogFile);

    expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s'");
    expect(statements.filter((statement) => /VALIDATE CONSTRAINT|CREATE INDEX/u.test(statement))).toEqual([]);
    const added = namesMatching(statements, /ADD CONSTRAINT (\w+) CHECK/gu);
    expect(added.length).toBeGreaterThan(0);
    expect(namesMatching(statements, /ADD CONSTRAINT (\w+) CHECK \(.*?\) NOT VALID/gu)).toEqual(added);
  });

  it("validate in 271 every check 270 added, before any index build holds writes", async () => {
    const added = namesMatching(await statementsOf(catalogFile), /ADD CONSTRAINT (\w+) CHECK/gu);
    const statements = await statementsOf(scanFile);

    expect(namesMatching(statements, /VALIDATE CONSTRAINT (\w+)/gu)).toEqual(added);
    const alters = statements.filter((statement) => statement.startsWith("ALTER TABLE"));
    expect(alters.every((statement) => /^ALTER TABLE \w+ VALIDATE CONSTRAINT \w+$/u.test(statement))).toBe(true);
    expect(statements.some((statement) => statement.startsWith("LOCK TABLE"))).toBe(false);
    const lastValidate = statements.map((statement) => statement.includes("VALIDATE CONSTRAINT")).lastIndexOf(true);
    const firstIndex = statements.findIndex((statement) => statement.startsWith("CREATE INDEX"));
    expect(firstIndex).toBeGreaterThan(lastValidate);
  });

  it("build in 271 the Inbox filter index and the index erasure and export read by scope", async () => {
    const statements = await statementsOf(scanFile);

    expect(namesMatching(statements, /CREATE INDEX (\w+)/gu))
      .toEqual(["idx_context_variable_values_variable_scope_data", "idx_context_variable_values_workspace_scope"]);
    expect(statements).toContain(
      "CREATE INDEX idx_context_variable_values_workspace_scope ON context_variable_values (workspace_id, scope_type, scope_id)",
    );
  });

  it("widen in 273 the enablement source CHECK to classified, with the lock wait bounded", async () => {
    const statements = await statementsOf("273_classified_context_variables.sql");

    expect(statements[0]).toBe("SET LOCAL lock_timeout = '3s'");
    expect(statements[1]).toContain("ADD CONSTRAINT agent_context_variables_source_check CHECK (source IN ('pushed', 'browser', 'resolver', 'request', 'classified'))");
  });
});
