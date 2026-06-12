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
