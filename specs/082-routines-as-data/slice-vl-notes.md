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

## Phase 2 — Pinned-Version Runtime Resolution

Red evidence:

- `cd backend && pnpm exec vitest run tests/integration/routine-lifecycle.integration.test.ts` initially failed with `expected 200 "OK", got 500 "Internal Server Error"` when a conversation pinned to the superseded version tried to continue after publishing the newer version.

Green evidence:

- `cd backend && pnpm exec vitest run tests/integration/routine-lifecycle.integration.test.ts` → 1 file passed, 1 test passed.
- `cd backend && pnpm exec vitest run tests/unit/routine-definition-composition.test.ts tests/integration/routine-lifecycle.integration.test.ts` → 2 files passed, 3 tests passed.
- `cd backend && pnpm exec tsc -p tsconfig.json --noEmit` → passed.
- `git diff --name-only packages/conversation-engine packages/conversation-contract` → no output; engine packages unchanged.

Implementation notes:

- ChatService now passes the active session routine id into the routine provider before the engine turn.
- Composition builds activation candidates from published routines only, then adds pinned registrations to the runner list as resume-only routines. When only resume-only routines exist, the activator is a no-op so new activation cannot see non-published versions.
- Code-reality deviation from the plan: current `routine_states.routine_id` stores the compiled runtime id (`routine:<agentId>:<name>:v<version>`), not the definition UUID described in the amendment. `loadPinned` therefore resolves pinned runtime ids by compiling all agent definitions across statuses and matching the compiled id, while still supporting direct `findByIdAnyStatus` lookup for UUID-style pins. The spec requirement is preserved: non-published pinned versions resume, but new activation still only uses `published` definitions.

## Phase 3 — Scoped-Directive Re-Pointing

Red evidence:

- `cd backend && pnpm exec vitest run tests/unit/agent-repository.test.ts tests/unit/routine-definition-service.test.ts` initially failed because `AgentRepository.repointRoutineScopeTags` did not exist and publish results still returned an empty orphan list.

Green evidence:

- `cd backend && pnpm exec vitest run tests/unit/agent-repository.test.ts tests/unit/routine-definition-service.test.ts` → 2 files passed, 38 tests passed.
- `cd backend && pnpm exec vitest run tests/integration/routine-lifecycle.integration.test.ts` → 1 file passed, 1 test passed.
- `cd backend && pnpm exec tsc -p tsconfig.json --noEmit` → passed.

Implementation notes:

- `AgentRepository` owns `agent_directives.scope_tags` mutation through `repointRoutineScopeTags`. It rewrites exact `routine:<old>` tags and `step:<old>:<stepId>` tags only when the step id survives, leaves removed-step tags untouched, and returns those untouched tags as `missing_step` orphans.
- `RoutineDefinitionRepository.publish` now accepts an `onPublished` lifecycle callback invoked inside the publish transaction after the previous published row is superseded and before commit.
- `RoutineDefinitionService.publish` calls the directive scope port from that callback and returns `directiveScopeOrphans` in successful publish results.

## Phase 4 — HTTP Contract + OpenAPI + SDK

Red evidence:

- `cd backend && pnpm exec vitest run tests/contract/agents.contract.test.ts` initially failed with `expected 200 "OK", got 404 "Not Found"` for `POST /api/v1/agents/:agentId/routines/:routineId/revise`.

Green evidence:

- `cd backend && pnpm exec vitest run tests/contract/agents.contract.test.ts` → 1 file passed, 27 tests passed.
- `cd backend && pnpm run generate:openapi` → passed after exporting `routineDefinitionStatuses` through the routines public barrel.
- `cd typescript-sdk && pnpm run sync` → passed.
- `cd packages/radioso-mcp-server && pnpm run sync:openapi` → passed.
- `cd typescript-sdk && pnpm run build` → passed.
- `cd typescript-sdk && pnpm test` → 6 files passed, 14 tests passed.
- `cd backend && pnpm run build` → passed.
- `cd backend && pnpm run test:unit` → 248 files passed, 1783 tests passed.
- `cd backend && pnpm run test:contract` → 27 files passed, 225 tests passed.
- `cd backend && pnpm exec vitest run tests/integration/routine-lifecycle.integration.test.ts` → 1 file passed, 1 test passed.

Regenerated artifacts:

- `backend/openapi.json`
- `backend/openapi.yaml`
- `typescript-sdk/openapi/radioso.json`
- `typescript-sdk/openapi/radioso.yaml`
- `typescript-sdk/src/generated/types.ts`
- `packages/radioso-mcp-server/src/generated/openapiTypes.ts`

Message-queue impact review:

- Searched routine lifecycle and queue references across `backend/src`, `backend/tests`, and `packages` for `routine_definition`, `routineDefinition`, `routineId`, `definition_id`, `completion_export`, `routine_completion_export`, `AMQP`, `amqp`, `queue`, `payload`, and `dispatch`.
- Completion export dispatch remains produced by the conversation engine as `webhook.send` with `payload.destinationRef` and `payload.source.{routineId,stepId,terminalKind}`; the host still persists that through `routine_action_requests` in `postgresAssistantTurnPersistence.ts`.
- AMQP/document worker dispatch wiring in `defaultComposition.ts` and document queue repositories are not affected by routine lifecycle status or lineage. No worker payload shape, retry semantics, AMQP queue names, queue contract tests, or queue docs require changes for Phases 1-4.

## Review Fixes

Red evidence:

- B1: review reproduced `23505` on live Postgres because `publish()` inserted a new `published` row before superseding the previous one under `idx_routine_definition_one_published_per_lineage`. The old unit test asserted that buggy insert-before-update order.
- M1: migration 090 could assign duplicate same-name drafts to one lineage, then fail while creating `idx_routine_definition_one_draft_per_lineage`.
- M2/m2: `publish()` had no in-transaction draft re-check, and `createRevisionDraft()` could surface a `23505` race instead of returning the raced-in draft.
- M3: pinned loading compiled drafts and had a dead definition-UUID fallback even though `routine_states.routine_id` stores compiled runtime ids.
- M4: lifecycle SQL/index behavior had no real-Postgres regression coverage.

Green evidence:

- `cd backend && pnpm exec vitest run tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-composition.test.ts tests/unit/routine-definition-service.test.ts tests/integration/routine-definition-repository-postgres.integration.test.ts` → 4 files passed, 36 tests passed.
- `cd backend && pnpm exec vitest run tests/integration/routine-lifecycle.integration.test.ts` → 1 file passed, 1 test passed.
- `cd backend && pnpm run build` → passed.
- `cd backend && pnpm run test:unit` → 248 files passed, 1786 tests passed.
- `cd backend && pnpm run test:contract` → 27 files passed, 225 tests passed.
- `cd backend && pnpm test -- tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-composition.test.ts tests/unit/routine-definition-service.test.ts` was attempted, but this repo script performed broad Vitest discovery and failed before the target assertions because the shared `INTEGRATION_DATABASE_URL` contains pre-existing data that trips migration 071's `non-default similarity_threshold` guard. The new real-Postgres regression test avoids that unrelated dirty shared state by using an isolated schema on a real Postgres client.

Implementation notes:

- B1/M2/m1: `RoutineDefinitionRepository.publish()` now locks by lineage, supersedes the existing published row first, updates the draft row in place to `published`, aborts on zero returned rows as `routine_definition_publish_conflict`, and invokes `onPublished` inside the same transaction with the draft id as the new definition id. First publish is v1; revision drafts keep their assigned next version and are consumed without gaps.
- M1/m3: migration 090 now repairs duplicate same-name drafts before building the one-draft partial index by keeping the newest draft in the grouped lineage and assigning fresh lineage ids to older duplicate drafts. It also adds `idx_routine_definition_lineage_version` on `(lineage_id, version)`.
- m2: `createRevisionDraft()` catches `23505` from the one-draft or lineage-version indexes and re-fetches the existing lineage draft.
- M3: pinned loading excludes drafts, resolves compiled-id collisions deterministically by status rank (`published` > `superseded` > `archived`) and then highest version, and removes the definition UUID lookup branch. Warn logging remains for load/compile failures.
- M4: added `routine-definition-repository-postgres.integration.test.ts`, using an isolated schema on a real Postgres connection to cover repository lifecycle/index behavior and migration 090 dirty-data repair.
- m4: publish audit metadata now includes `supersededDefinitionId` and a numeric `directiveScopeOrphans` count only, alongside ids/version/status.
- m6: chat turn handling now loads active routine state once and threads it into routine turn setup instead of calling `routineStore.loadActive` twice per turn.
- OpenAPI/SDK/MCP registry shape did not change. Existing generation/check scripts reported API contract artifacts current; no SDK or MCP generated files needed to be committed for this fix.

## Phase 5-6 — Dashboard, Docs, and Final Validation

Red evidence:

- `cd frontend && pnpm exec tsc --noEmit` initially reported routines e2e fixture errors because local mutation arrays widened `method` to `string`, `baseRoutine` used readonly arrays, and the Playwright fixture still modeled the old publish contract by returning a new published id and bumping the version at publish time.
- The same check also exposed a nearby `webhook-destinations-settings.spec.ts` fixture-array typing issue against the shared e2e dashboard fixture.
- The routines Playwright assertions expected first publish to navigate to a new `...9555...000000000002` id and show `published v2`, and expected revise+publish from v1 to show `v3`. Backend contract review showed publish now updates the draft row in place and keeps the draft's assigned version.

Green evidence:

- `cd frontend && pnpm exec tsc --noEmit` → still fails on pre-existing frontend errors outside this slice, including `components/dashboard/agent-view.tsx`, `components/dashboard/chat-view.tsx`, `components/dashboard/quality-view.tsx`, markdown components, and unrelated unit tests. No reported error references `frontend/components/dashboard/settings/assistant-routines-section.tsx`, `frontend/lib/routine-lineage.ts`, `frontend/lib/api-routines.ts`, `frontend/lib/api-types.ts`, `frontend/tests/e2e/dashboard-fixtures.ts`, `frontend/tests/e2e/routines-settings.spec.ts`, `frontend/tests/e2e/webhook-destinations-settings.spec.ts`, or the targeted routine unit tests.
- `cd frontend && pnpm run lint` → passed.
- `cd frontend && pnpm vitest run tests/unit/routine-lineage.test.ts tests/unit/routines-api.test.ts tests/unit/routine-form.test.ts` → 3 files passed, 18 tests passed.
- `cd frontend && pnpm run test:e2e -- routines-settings.spec.ts` → 5 tests passed.

Implementation notes:

- Dashboard routines now group rows by `lineageId`, show one active row per lineage, expose draft-revision state, archive/restore actions, and a version-history panel in the editor.
- The frontend API adapter and types include `lineageId` plus `draft|published|superseded|archived` status handling and revise/archive/restore calls.
- The e2e dashboard fixture now matches the backend contract: first publish keeps the draft id and v1, revision drafts receive the next gapless lineage version, and publish consumes that draft without minting another id or version.
- The editor publish flow was reviewed against the same-row publish contract. It uses the API response id/version and replaces the saved draft row with the published response while superseding the previous published row in local state.
- `docs/document-writer-prompt.md` was read before docs edits. Routine authoring and architecture docs now describe revise → publish → supersede, archive/restore, and in-flight pinned-version behavior instead of a two-state lifecycle.

## Review Pass 2 Fixes

Red evidence:

- In-place publish and restore no longer inserted or updated `routine_completion_export`, so the production trigger `trg_routine_completion_export_destination` did not re-check enabled destination references after `routine_definition.status` changed to `published`.
- The real-Postgres integration fixture used copied routine DDL without the migration 089 trigger/function, so the repository tests could not catch a deleted webhook destination between validation and publish/restore commit.
- `cd frontend && pnpm run test:e2e -- routines-settings.spec.ts` initially failed with a timeout in the outline editor after validate navigation; the lineage revise/publish case passed on rerun, but the outline test needed an explicit wait for the persisted draft editor state.

Green evidence:

- `cd backend && pnpm exec vitest run tests/integration/routine-definition-repository-postgres.integration.test.ts tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-service.test.ts tests/unit/routine-definition-composition.test.ts` → 4 files passed, 39 tests passed.
- `cd frontend && pnpm vitest run tests/unit/routine-lineage.test.ts` → 1 file passed, 4 tests passed.
- `cd backend && pnpm run build` → passed.
- `cd frontend && pnpm run lint` → passed.
- `cd backend && pnpm run test:unit` → 248 files passed, 1787 tests passed.
- `cd backend && pnpm run test:contract` → 27 files passed, 225 tests passed.
- `cd frontend && pnpm run test:e2e -- routines-settings.spec.ts` → passed on rerun after stabilizing the persisted-editor wait, 5 tests passed.

Implementation notes:

- `RoutineDefinitionRepository.publish()` and `restore()` now touch enabled completion-export rows inside their lifecycle transactions, causing migration 089's destination trigger to take its `FOR KEY SHARE` lock and reject missing destination refs before commit.
- Publish maps the trigger constraint back into the existing rejected-validation result with an `unknown_webhook_destination` diagnostic. Restore maps the same constraint to a 400 author-facing error that names the missing destination ref.
- The real-Postgres repository test installs the production migration 089 trigger/function into its isolated schema and covers both deleted-before-publish and deleted-while-archived-before-restore cases, asserting no dangling published export remains.
- Removed dead `findByIdAnyStatus` production/fake repository code.
- Updated lifecycle docs/spec wording for in-place publish, added the missing OpenAPI 400 publish response, regenerated OpenAPI/SDK/MCP artifacts, switched the routines date formatter to user locale, kept draft-plus-archived lineages visible in the active list with version history, and made the e2e restore fixture reject a restore when another lineage version is published.

## Final gate (T024)

- `pnpm run ci:local -- origin/main` → **passed** ("Local CI checks passed", exit 0) on final HEAD `3967cd3ce` (2026-06-12).
- Earlier full-gate run at `f5b9ca676` also passed after resolving two pre-existing shared-dev-DB issues unrelated to this diff: a leftover "Threshold Guard Workspace" test fixture tripping migration 080's re-run guard (deleted from the dev DB), and migration 085's transitional guard-kind CHECK not being re-runnable after 089's cut (fixed in `f5b9ca676`).
- EM pass verdict: ship. Fast-follows filed in the PR body: dashboard surfacing of `directiveScopeOrphans`; persist definition UUID in `routine_states` for new pins to retire the compile-all `loadPinned` path.

## PR review fixes (scope-tag identity + updateDraft race)

Two HIGH findings from PR #684 review.

**Finding 1 — scope-tag identity.** Verified worse than reported: directive scope tags were broken for DB-authored routines in BOTH formats — definition-UUID tags (what the re-point writes) never matched the compiled `routine:<agentId>:<name>:v<version>` activeRoutineId, and compiled-id tags break the engine's `step:<rid>:<sid>` parser outright (the compiled id's colons trip the extra-segment check). Fix: **the compiled routine id IS the definition id** (`compiler.ts`), unifying trace activeRoutineId = Coach tag id = re-point target = routine_states pin, with zero engine changes.

- `routineDefinitionSource.loadPinned`: UUID pins resolve via new `findPinnedById` (status <> 'draft', direct lookup — retires the compile-all path for new pins); legacy `routine:<agent>:<name>:v<n>` pins keep a lazily-built fallback map and are re-exposed under the pinned id so the runner's `routine.id === state.routineId` resume holds. Fallback removable once legacy routine_states age out (TTL).
- Migration `091_routine_scope_tag_definition_ids.sql`: best-effort rewrite of legacy compiled-id scope tags to definition ids (anchored both-ends parse; names containing colons covered by test; unresolvable tags untouched; re-runnable).
- Static code-registered routines unaffected (hand-assigned ids never used the compiled formula).

**Finding 2 — updateDraft race.** `updateDraft` ran `replaceChildren` unconditionally after a status-guarded UPDATE with no row-count check; a save racing the in-place publish could rewrite a published version's children. Fix: `RETURNING id` + zero-row abort (`routine_definition_update_conflict`) before any child mutation; service maps it to HTTP 409 ("published concurrently — revise to continue editing").

Red/green evidence (red = each new test failed against the pre-fix code by construction; composition/domain tests asserted the OLD id format and were updated):

- `routine-definition-composition.test.ts` → 6/6: compiled id = definition id; UUID pin direct path (no listByAgent scan); legacy pin fallback excl. drafts; legacy collision rank.
- `routine-lifecycle.integration.test.ts` → 2/2 incl. new SC-020 runtime-identity test: pinned `routine_states.routine_id` equals the published definition id and a re-point-format tag (`step:<defId>:<stepId>`) is `isDirectiveEligibleForTurn`-eligible for that turn context.
- `routine-definition-repository-postgres.integration.test.ts` → 6/6 (real Postgres): updateDraft race rejected with children unchanged; migration 091 rewrites legacy tags (incl. colon-containing routine name) and leaves unresolvable tags, re-runnable.
- `routine-definition-repository.test.ts` → 10/10 incl. zero-row abort-before-children; `routine-definition-service.test.ts` → 24/24 incl. 409 mapping.
- Full suites: `pnpm run test:unit` 1791 passed; integration/contract/build re-run in the same round (see PR).

Note: the local Postgres container was found stopped during this round (real-DB suites silently skip without `INTEGRATION_DATABASE_URL` + a reachable DB — they report green via skip; restarted `radioso-postgres-1` and re-ran with the env var set).
