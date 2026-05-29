# Phase 2 Plan: OSS Ledger Migration

**Parent Spec**: [spec.md](./spec.md) — Delivery Split item 2
**Status**: Implemented (D1/D2/D3 approved). Backend + EE typecheck clean; backend unit suite green except the one pre-existing unrelated `sourceUrl` citation failure; EE tests green. The Postgres-backed migration/rename test is gated on `INTEGRATION_DATABASE_URL` and must be validated in the CI integration lane — it cannot run in this DB-less workspace.

**Message-queue review**: no change. The recorder contract is unchanged (types relocated, not altered); document-worker embedding usage still flows through the same `UsageEventRecorder` port with the same deterministic idempotency key, so no AMQP payload, retry, or queue-doc change is needed.
**Scope**: Move durable usage-event persistence (events, embedding items, daily rollups) into the OSS substrate; collapse the duplicated recorder types into one shared contract; preserve existing Enterprise data and behavior. No new recorder call sites (Phase 4), no identity-model extension (Phase 3), no pricing (Phase 5).

## Verified starting state

- **Tables** `ee_usage_events`, `ee_embedding_usage_items`, `ee_usage_daily_rollups` are created by the EE `usageLimitMigrator` (`ee/packages/backend-module/src/usageLimits/usageLimitMigrator.ts`) and written only by `EnterpriseUsageEventRecorder`. No other reader exists in OSS or EE. Usage-*limit* tables (profiles/assignments/counters/reservations) are separate and stay EE.
- **Migration ordering** (`backend/src/runtime/startApiRuntime.ts`): OSS SQL migrations (`runMigrations`, `:33`) run before EE programmatic migrators (`migrateAll`, `:38`). OSS migrations are plain sorted `.sql` files tracked in `schema_migrations`.
- **Recorder wiring**: EE registers the recorder via `context.registerUsageEventRecorder(({database}) => new EnterpriseUsageEventRecorder(...))`. OSS default registers `NoopUsageEventRecorder` (`dependencyBuilders.ts:175`).
- **Type duplication is three-way**: OSS `shared/domain/usageEventRecorder.ts`, EE `radiosoModuleTypes.ts`, EE `usageEventRecorder.ts`. EE does not import OSS source by design; shared shapes live in contract packages (`@radioso/skill-contract`).
- **No Postgres in this workspace.** Migration DDL and recorder SQL cannot be integration-tested here; only fake-DB unit tests run. Phase 2 must land with a Postgres-backed integration test that runs in CI, but that test cannot be executed locally in this environment.

## Decisions Required (block implementation)

### D1 — Table ownership mechanism
**Recommendation: rename in place.** A new OSS SQL migration renames `ee_usage_events`→`usage_events`, `ee_embedding_usage_items`→`embedding_usage_items`, `ee_usage_daily_rollups`→`usage_daily_rollups` with `ALTER TABLE IF EXISTS … RENAME TO …`, then `CREATE TABLE IF NOT EXISTS …` for fresh installs, then `ALTER INDEX IF EXISTS … RENAME` to normalize index names. EE `usageLimitMigrator` drops all event-table DDL (keeps limit tables). Rename preserves rows, the `idempotency_key` UNIQUE constraint, and FKs (FK constraint names stay `ee_*` on upgraded installs — cosmetic; documented).
- *Alternative (rejected): copy ee→new and keep ee as deprecated.* Causes dual-write/drift and a reconciliation burden the spec explicitly warns against.

### D2 — Shared contract location for recorder types
**Recommendation: a new workspace contract package** (e.g. `packages/usage-contract`, published as `@radioso/usage-contract`) owning `UsageEventStatus`, `UsageEventQuality`, `EmbeddingUsageEvent`, `ModelUsageEvent`, and the `UsageEventRecorder` port. OSS `shared/domain/usageEventRecorder.ts` and EE both import it; the three duplicated copies collapse to one. This mirrors `@radioso/skill-contract`/`connector-api` precedent and keeps EE from importing OSS source.
- *Alternative (rejected): EE imports `backend/src`.* Violates the established EE/OSS boundary (EE never imports OSS source).
- *Alternative (lighter): extend an existing contract package* instead of a new one — acceptable if we prefer fewer packages; names the same types.

### D3 — Where the durable recorder lives, and EE's role
**Recommendation:** move the durable recorder implementation into OSS (`backend/src/modules/usage/` or `shared/`), writing to the renamed tables via the shared port. OSS default composition registers it (replacing the Noop default) so **OSS installs get durable accounting out of the box** (FR-027). EE stops registering its own recorder (deletes `EnterpriseUsageEventRecorder`, or keeps a thin re-export for one release) and consumes the OSS substrate. EE behavior is preserved because the recorder logic and schema are unchanged apart from table names.
- *Open sub-question:* keep the daily-rollup write in the recorder transaction (current behavior) vs. make summaries read events directly. Phase 2 keeps the existing rollup-in-transaction write for behavior preservation; the workspace/surface rollup-dimension gap and rebuildability (FR-023, spec Substrate Caveats) are addressed in Phase 5 when summaries are built. Phase 2 only adds a documented "rebuild rollups from events" path as required by the Rollup Recovery Rule.

## Implementation outline (after D1–D3 sign-off)

1. **Contract package (D2)**: create it, move the canonical types in, point OSS `shared/domain/usageEventRecorder.ts` and EE at it. TDD: tsc across backend + ee + the package; existing EE recorder unit test stays green.
2. **OSS migration (D1)**: add `backend/src/db/migrations/NNNN_usage_ledger_oss.sql` (rename-then-create-then-normalize). EE `usageLimitMigrator` loses event-table DDL.
3. **OSS durable recorder (D3)**: port `EnterpriseUsageEventRecorder` logic into OSS against the renamed tables and shared port; unit-test with the same fake-DB harness the EE test uses; flip OSS default registration from Noop to durable.
4. **EE compat**: EE module no longer registers its own recorder; verify EE build + EE usage-limit integration test assumptions still hold (limits never read event tables, so expected to be unaffected).
5. **Integration test**: a Postgres-backed test proving (a) fresh install creates `usage_events` and records, (b) an install with legacy `ee_usage_events` rows is renamed with data intact and continues recording idempotently. **Cannot run in this workspace (no PG); must pass in CI.**
6. **Docs/contracts**: message-queue review (worker embedding-usage payloads already carry idempotency identity — confirm unchanged); update any operator docs that named EE-only usage tables.

## Guardrails / out of scope
No identity-model change (single `idempotencyKey` stays until Phase 3), no new call sites, no pricing/summaries/UI, no rollup-dimension changes beyond documenting the rebuild path.

## Acceptance criteria
- One set of recorder types, imported by both OSS and EE; tsc clean across all three packages.
- OSS installs record durable usage events with no EE package present (FR-027).
- Existing EE `ee_usage_events` data is preserved and queryable under the new table names; recording remains idempotent (SC-005).
- EE usage-limit behavior unchanged (FR-029).
- Postgres-backed migration/rename + record test green in CI.
