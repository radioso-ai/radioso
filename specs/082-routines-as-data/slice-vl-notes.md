# Versioning Lifecycle Slice Notes

## Phase 1 — Lineage + Status Model

Red evidence:

- `cd backend && pnpm test -- tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-service.test.ts` initially failed after dependency install. The script scanned unrelated integration files, but the intended failures were present: repository publish still locked by `agent_id:name`, `createRevisionDraft`/`archive`/`restore` were missing, publish results omitted `directiveScopeOrphans`, and service `revise`/`archive`/`restore` were missing.

Green evidence:

- `cd backend && pnpm exec vitest run tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-service.test.ts` → 2 files passed, 28 tests passed.
- `cd backend && pnpm exec tsc -p tsconfig.json --noEmit` → passed.

Implementation notes:

- Added `lineageId` to routine domain/schema mapping and extended statuses to `draft|published|superseded|archived`.
- Added migration `090_routine_lineage_lifecycle.sql` with lineage backfill, older-published retro-supersede, one-draft and one-published partial indexes, and `(agent_id, lineage_id)` index.
- Repository publish now locks/version-increments by lineage, snapshots the published version, supersedes prior published rows, and deletes the draft in the same transaction. Revision draft creation preserves stable child ids and completion export by copying the published definition through the existing child replacement helper.
- Service owns transition legality and emits audit events for publish, revise, archive, and restore with workspace/agent/routine/lineage/version/status correlation only.
