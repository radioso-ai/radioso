import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("variable embedding dimension migration", () => {
  it("does not rebuild the HNSW index during startup migrations", async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationSql = await Promise.all([
      "057_variable_embedding_dimensions.sql",
      "058_embedding_unbounded_compat.sql",
    ].map((migrationFile) =>
      readFile(path.resolve(__dirname, "../../src/db/migrations", migrationFile), "utf8"),
    ));
    const sql = migrationSql.join("\n");

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS embedding_unbounded VECTOR");
    expect(sql).not.toMatch(/ALTER\s+COLUMN\s+embedding\s+TYPE/i);
    expect(sql).not.toMatch(/CREATE\s+INDEX[\s\S]+USING\s+hnsw/i);
  });
});
