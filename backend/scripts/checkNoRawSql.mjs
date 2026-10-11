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
  "shared/infra/database.ts", // the pg Pool wrapper + DatabaseExecutor the runner uses
  "db/repositories/chunkEmbeddingRepository.ts", // canonical vector batch shares document publication's existing pg transaction
  "db/repositories/documentProcessingJobRepository.ts", // profile jobs are inserted inside canonical publication's existing pg transaction
  "db/repositories/vectorIndexWorkRepository.ts", // projection work/tombstones share canonical mutation transactions
  "modules/retrieval/infra/hnswIterativeScan.ts", // `SET LOCAL hnsw.iterative_scan` needs a raw session
  "modules/retrieval/infra/pgVectorAdapter.ts", // canonical pgvector exact candidate search
  "modules/retrieval/infra/lexicalSearch.ts", // full-text `@@` / ts_rank
  "modules/documents/infra/chunkRepository.ts", // chunk rows share document publication's existing pg transaction
  // Bound to the published @radioso/connector-api `ConnectorDatabasePort` (query-only).
  // Tracked follow-up: migrate once that contract exposes Kysely (bridge: connectorKyselyDb.ts).
  "modules/connectors/services/connectorRegistry.ts",
  "modules/connectors/plugins/whatsapp/whatsappPlugin.ts",
]);

// pgvector syntax in a Kysely `sql` template is a storage-adapter concern, just as a
// raw pg `.query()` is. Keep it in these adapter homes rather than allowing a
// repository or service to make a database-specific vector assumption.
export const PGVECTOR_SQL_ALLOWLIST = new Set([
  "db/repositories/chunkEmbeddingRepository.ts", // canonical pgvector batch writer; vector write lifecycle stays with canonical storage
  "db/repositories/vectorIndexWorkRepository.ts", // canonical pgvector projection payload reader; hydration stays with canonical storage
  "modules/retrieval/infra/chunkEmbeddingVectorIndex.ts", // pgvector HNSW DDL and matching distance expression
  "modules/retrieval/infra/hnswIterativeScan.ts", // pgvector HNSW session settings
  "modules/retrieval/infra/pgVectorAdapter.ts", // canonical pgvector candidate-search adapter
  "shared/infra/kysely/pgVectorSql.ts", // shared Kysely pgvector cast and distance adapter
]);

// `.query(`, `.queryOne(`, `.queryOptional(` — incl. a `<T>` type arg. Kysely builders expose none.
const RAW_SQL_MARKER = /\.(query|queryOne|queryOptional)\s*(<[^>]*>)?\s*\(/;

export const lineHasRawSql = (line) => RAW_SQL_MARKER.test(line);

const PGVECTOR_SQL_SYNTAX = /::\s*(?:vector|halfvec)\b|\b[\w.]*embedding[\w.]*\s*::\s*text\b|<=>|<->|<#>|\bvector_dims\s*\(|\b(?:hnsw|ivfflat)\b/i;
const KYSELY_SQL_TEMPLATE = /\bsql(?:<[^>`]*>)?\s*`/;

export const lineHasPgVectorSql = (line) =>
  KYSELY_SQL_TEMPLATE.test(line) && PGVECTOR_SQL_SYNTAX.test(line);

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

export const findPgVectorSqlViolations = (srcDir) => {
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
      if (PGVECTOR_SQL_ALLOWLIST.has(rel)) continue;
      const lines = readFileSync(full, "utf8").split("\n");
      let inSqlTemplate = false;
      let waitingForRawSqlTemplate = false;
      lines.forEach((line, i) => {
        const opensKyselyTemplate = KYSELY_SQL_TEMPLATE.test(line);
        const opensRawQuery = RAW_SQL_MARKER.test(line);
        const opensReturnedSql = /\breturn\s+`/.test(line);
        const hasTemplateDelimiter = line.includes("`");
        const isSql = inSqlTemplate
          || opensKyselyTemplate
          || opensReturnedSql
          || opensRawQuery
          || (waitingForRawSqlTemplate && hasTemplateDelimiter);
        if (isSql && PGVECTOR_SQL_SYNTAX.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
        if (opensRawQuery && !hasTemplateDelimiter) {
          waitingForRawSqlTemplate = true;
        }
        if (waitingForRawSqlTemplate && hasTemplateDelimiter) {
          waitingForRawSqlTemplate = false;
        }
        if (isSql && hasTemplateDelimiter) {
          const ticks = line.match(/`/g)?.length ?? 0;
          if (ticks % 2 === 1) {
            inSqlTemplate = !inSqlTemplate;
          }
        }
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
  const pgvectorOffenders = findPgVectorSqlViolations(srcDir);
  if (offenders.length > 0 || pgvectorOffenders.length > 0) {
    if (offenders.length > 0) {
      console.error("✖ Raw SQL execution found outside the Kysely allowlist (spec 093):");
    }
    for (const o of offenders) console.error("  " + o);
    if (pgvectorOffenders.length > 0) {
      console.error("✖ pgvector SQL found outside the vector-adapter allowlist:");
    }
    for (const o of pgvectorOffenders) console.error("  " + o);
    console.error(
      `\n${offenders.length + pgvectorOffenders.length} violation(s). Migrate raw execution to Kysely and pgvector fragments to shared/infra/kysely/pgVectorSql.ts, or add a genuine vector storage adapter file to its allowlist with a justifying comment.`,
    );
    process.exit(1);
  }
  console.log("✔ no raw SQL outside the Kysely allowlist");
}
