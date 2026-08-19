import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The lexical GIN index is an *expression* index. Postgres only uses it when the
// query's tsvector expression is textually equivalent to the indexed expression.
// A silent drift between the two (the query gained a `content` fallback the index
// never had) made every lexical search a sequential scan over all chunk partitions.
// This test pins them together so the drift cannot recur unnoticed.

const schemaPath = new URL("../../../src/db/schema.sql", import.meta.url);
const lexicalSearchPath = new URL(
  "../../../src/modules/retrieval/infra/lexicalSearch.ts",
  import.meta.url,
);

const normalizeExpression = (expression: string): string =>
  expression
    .toLowerCase()
    .replaceAll("::regconfig", "")
    .replaceAll("::text", "")
    // Column references are alias-qualified in the query and bare in the index
    // definition; the planner compares the resolved column, not the alias.
    .replaceAll(/\bc\./g, "")
    .replaceAll(/\s+/g, " ")
    .trim();

const extractIndexedExpression = (schema: string): string => {
  const match = schema.match(
    /CREATE INDEX chunks_search_text_fts_idx ON ONLY public\.chunks USING gin \((.+)\);/,
  );
  if (!match?.[1]) {
    throw new Error("chunks_search_text_fts_idx not found in schema.sql");
  }
  return match[1];
};

const extractQueryExpression = (source: string): string => {
  const match = source.match(/(to_tsvector\('simple',[^)]*\([^)]*\)\))\s+AS search_vector/);
  if (!match?.[1]) {
    throw new Error("lexical search_vector expression not found");
  }
  return match[1];
};

describe("lexical search index alignment", () => {
  it("computes the same tsvector expression the GIN index is built on", async () => {
    const [schema, source] = await Promise.all([
      readFile(schemaPath, "utf8"),
      readFile(lexicalSearchPath, "utf8"),
    ]);

    expect(normalizeExpression(extractQueryExpression(source)))
      .toBe(normalizeExpression(extractIndexedExpression(schema)));
  });

  it("keeps every chunk partition's FTS index on that same expression", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const indexed = normalizeExpression(extractIndexedExpression(schema));

    const partitionExpressions = [
      ...schema.matchAll(
        /CREATE INDEX chunks_p\d+_to_tsvector_idx ON public\.chunks_p\d+ USING gin \((.+)\);/g,
      ),
    ].map((match) => normalizeExpression(match[1] ?? ""));

    expect(partitionExpressions.length).toBeGreaterThan(0);
    for (const expression of partitionExpressions) {
      expect(expression).toBe(indexed);
    }
  });
});
