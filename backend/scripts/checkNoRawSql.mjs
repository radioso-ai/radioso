#!/usr/bin/env node
// US4 (spec 093): forbid raw SQL execution outside a tight, documented allowlist.
//
// Application data access goes through Kysely. The only legitimate raw-SQL homes are the
// migration runner, the pg Pool wrapper it uses, the pgvector/full-text adapters (whose
// operators Kysely can't type), and the two connector files bound to the published
// `@radioso/connector-api` ConnectorDatabasePort (a tracked follow-up — see connectorKyselyDb.ts).
//
// Kysely's own raw escape hatches (`sql\`\``, `CompiledQuery.raw` + `.executeQuery`) are allowed:
// they run through the shared Kysely instance, not a separate pg path. We key on the
// `.query(` / `.queryOne(` / `.queryOptional(` markers, which only the Database wrapper and the
// raw pg client expose — Kysely query builders have none of them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWLIST = new Set([
  "db/runMigrations.ts", // migration runner: migrations stay raw .sql by design
  "shared/infra/database.ts", // the pg Pool wrapper + DatabaseExecutor the runner/legacy paths use
  "db/repositories/chunkEmbeddingRepository.ts", // canonical vector batch shares document publication's existing pg transaction
  "db/repositories/documentProcessingJobRepository.ts", // profile jobs are inserted inside canonical publication's existing pg transaction
  "db/repositories/vectorIndexWorkRepository.ts", // projection work/tombstones share canonical mutation transactions
  "modules/retrieval/infra/vectorSearch.ts", // pgvector `<=>` distance + hnsw.iterative_scan
  "modules/retrieval/infra/pgVectorAdapter.ts", // canonical pgvector exact candidate search
  "modules/retrieval/infra/chunkVectorStorage.ts", // pgvector `::vector` chunk insert
  "modules/retrieval/infra/lexicalSearch.ts", // full-text `@@` / ts_rank
  "modules/documents/infra/chunkRepository.ts", // pgvector chunk insert
  // Bound to the published @radioso/connector-api `ConnectorDatabasePort` (query-only).
  // Tracked follow-up: migrate once that contract exposes Kysely (bridge: connectorKyselyDb.ts).
  "modules/connectors/services/connectorRegistry.ts",
  "modules/connectors/plugins/whatsapp/whatsappPlugin.ts",
]);

// `.query(`, `.queryOne(`, `.queryOptional(` — incl. a `<T>` type arg. Kysely builders expose none.
const RAW_SQL_MARKER = /\.(query|queryOne|queryOptional)\s*(<[^>]*>)?\s*\(/;

export const lineHasRawSql = (line) => RAW_SQL_MARKER.test(line);

export const findRawSqlViolations = (srcDir) => {
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
      if (ALLOWLIST.has(rel)) continue;
      readFileSync(full, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (lineHasRawSql(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  };
  walk(srcDir);
  return offenders;
};

// CLI entry (skipped when imported by the fixture test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders = findRawSqlViolations(srcDir);
  if (offenders.length > 0) {
    console.error("✖ Raw SQL execution found outside the Kysely allowlist (spec 093):");
    for (const o of offenders) console.error("  " + o);
    console.error(
      `\n${offenders.length} violation(s). Migrate to Kysely, or — if genuinely raw (pgvector/FTS/migration/published connector contract) — add the file to ALLOWLIST in scripts/checkNoRawSql.mjs with a justifying comment.`,
    );
    process.exit(1);
  }
  console.log("✔ no raw SQL outside the Kysely allowlist");
}
