import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ENCRYPTED_FIELD_LOCATIONS } from "../../src/db/repositories/encryptedFieldRepository.js";

const SCHEMA_SQL = readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8");

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

  it("lists every ciphertext column in the schema, so key rotation re-encrypts all of them", () => {
    const ciphertextColumns = [...schemaColumns()].filter((column) => column.split(".")[1].includes("ciphertext"));

    expect(ciphertextColumns.length).toBeGreaterThan(0);
    expect(ciphertextColumns.filter((column) => !registered.includes(column))).toEqual([]);
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
