import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ENCRYPTED_FIELD_LOCATIONS } from "../../src/db/repositories/encryptedFieldRepository.js";

const SCHEMA_SQL = readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8");

/**
 * Column names that say a column holds ciphertext. `*_ciphertext` is the convention the registry asks
 * for; `sealed` and `encrypted` catch the other names the same thing goes by.
 */
const CIPHERTEXT_COLUMN_NAME = /ciphertext|sealed|encrypted/;

/**
 * Ciphertext columns under a key other than CONNECTOR_ENCRYPTION_KEY, which the credential
 * re-encryption command must leave alone. Each entry says which key encrypts it.
 */
const ENCRYPTED_UNDER_ANOTHER_KEY: Record<string, string> = {
  // An agent-api grant's token, sealed with WORKSPACE_TOKEN_SECRET by `encryptSecret` (authPrimitives.ts).
  "agent_access_grants.encrypted_token": "WORKSPACE_TOKEN_SECRET",
};

/** `table.column` for every column of every table in the committed schema dump. */
const schemaColumns = (): Set<string> => {
  const columns = new Set<string>();
  for (const table of SCHEMA_SQL.matchAll(/^CREATE TABLE public\.(\w+) \(\n([\s\S]*?)\n\);/gm)) {
    for (const column of table[2].matchAll(/^ {4}(\w+) /gm)) {
      columns.add(`${table[1]}.${column[1]}`);
    }
  }
  return columns;
};

describe("the registry of encrypted credential locations", () => {
  const registered = ENCRYPTED_FIELD_LOCATIONS.map((location) => location.label);

  it("lists every column whose name says it holds ciphertext, so key rotation re-encrypts all of them", () => {
    const ciphertextColumns = [...schemaColumns()]
      .filter((column) => CIPHERTEXT_COLUMN_NAME.test(column.split(".")[1]))
      .filter((column) => !(column in ENCRYPTED_UNDER_ANOTHER_KEY));

    expect(ciphertextColumns.length).toBeGreaterThan(0);
    expect(ciphertextColumns.filter((column) => !registered.includes(column))).toEqual([]);
  });

  it("excludes only columns the schema has and the registry does not list", () => {
    const columns = schemaColumns();

    for (const column of Object.keys(ENCRYPTED_UNDER_ANOTHER_KEY)) {
      expect(columns.has(column)).toBe(true);
      expect(registered).not.toContain(column);
    }
  });

  it("names only columns the schema has", () => {
    const columns = schemaColumns();

    expect(registered.filter((label) => !columns.has(label))).toEqual([]);
    for (const location of ENCRYPTED_FIELD_LOCATIONS) {
      for (const keyColumn of location.keyColumns) {
        expect(columns.has(`${location.table}.${keyColumn}`)).toBe(true);
      }
    }
  });

  it("lists each location once", () => {
    expect(new Set(registered).size).toBe(registered.length);
  });
});
