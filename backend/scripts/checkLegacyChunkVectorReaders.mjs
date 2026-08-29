#!/usr/bin/env node
// Issue #1101: runtime retrieval now reads canonical `chunk_embeddings` only.
// The legacy `chunks.embedding` / `chunks.embedding_unbounded` columns remain until
// a later migration, after every old application revision has drained. Keep this
// zero-reader guard in place through that interval so a new reader cannot silently
// make the migration unsafe again.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// A non-empty list would mean code had regressed to the retired storage path. The
// later column-drop migration removes this guard together with the columns.
export const ALLOWLIST = new Map();

// Generated from the live database schema, so it names the columns as long as they
// exist. It describes the schema rather than reading it at runtime.
const GENERATED_FILES = new Set([
  "shared/infra/kysely/schema.ts",
]);

// Double-quoted SQL identifiers and double-quoted query-builder strings normalize to
// the same token shape without changing line boundaries used in diagnostics.
const normalizeIdentifiers = (source) =>
  source.replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, "$1");

const firstLegacyChunkVectorIndex = (source) => {
  const normalized = normalizeIdentifiers(source);
  const patterns = [
    /\bembedding_unbounded\b/i,
    /\b(?:c|ch|chunks)\s*\.\s*embedding\b/i,
    /\binsert\s+into\s+chunks\s*\([^)]*\bembedding\b/is,
    /\bselect\b(?:(?!\bfrom\b)[\s\S])*?\bembedding\b(?:(?!\bfrom\b)[\s\S])*?\bfrom\s+chunks\b/i,
    /\.selectFrom\(\s*["']?chunks(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?["']?\s*\)[\s\S]{0,2000}?\.select\(\s*\[?\s*["']?(?:[A-Za-z_][A-Za-z0-9_]*\.)?embedding["']?/i,
  ];
  const indexes = patterns
    .map((pattern) => pattern.exec(normalized)?.index)
    .filter((index) => index !== undefined);
  return indexes.length > 0 ? Math.min(...indexes) : -1;
};

// It accepts a complete source string as well as one line so statement-level patterns
// can be tested without weakening the source-tree scan.
export const lineReadsLegacyChunkVector = (source) =>
  firstLegacyChunkVectorIndex(source) >= 0;

export const findLegacyChunkVectorReaders = (srcDir) => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const rel = relative(srcDir, full).split("\\").join("/");
      if (ALLOWLIST.has(rel) || GENERATED_FILES.has(rel)) continue;
      const source = readFileSync(full, "utf8");
      const matchIndex = firstLegacyChunkVectorIndex(source);
      if (matchIndex >= 0) {
        const lineNumber = source.slice(0, matchIndex).split("\n").length;
        const line = source.split("\n")[lineNumber - 1]?.trim() ?? "";
        offenders.push(`${rel}:${lineNumber}: ${line}`);
      }
    }
  };
  walk(srcDir);
  return offenders;
};

// CLI entry (skipped when imported by the fixture test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = findLegacyChunkVectorReaders(srcDir);
  if (offenders.length > 0) {
    console.error("✖ Runtime reader of the retired legacy chunk vector columns found (issue #1101):");
    for (const offender of offenders) console.error("  " + offender);
    console.error(
      `\n${offenders.length} violation(s). Read vectors from chunk_embeddings instead; `
      + "the legacy columns exist only until their reviewed column-drop migration.",
    );
    process.exit(1);
  }
  console.log("✔ no runtime readers of the legacy chunk vector columns");
}
