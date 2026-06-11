# Tasks: 082 Amendment Authoring Surface Slices 1-4

**Input**: `specs/082-routines-as-data/amendment-authoring-surface.md`
**Plan**: `specs/082-routines-as-data/plan-authoring-surface.md`

## Phase 1: Setup

- [X] T001 Verify branch `routine-text-composer` and confirm existing user changes before edits.
- [X] T002 Create amendment planning artifacts in `specs/082-routines-as-data/plan-authoring-surface.md` and `specs/082-routines-as-data/tasks-authoring-surface.md` without modifying shipped `plan.md`.

## Phase 2: Tests First

- [X] T003 [P] Add failing golden round-trip tests for `draft -> document -> draft` and `draft -> text -> parse -> draft` in `backend/tests/unit/routine-document-roundtrip.test.ts`.
- [X] T004 [P] Add failing tests for branch-vs-nuance and token-less-beat diagnostics in `backend/tests/unit/routine-document-roundtrip.test.ts`.
- [X] T005 [P] Add failing tests for source-map mapping of validator-style locations in `backend/tests/unit/routine-document-roundtrip.test.ts`.

## Phase 3: Document Module

- [X] T006 Add document AST and source-map types in `backend/src/modules/routines/document/model.ts`.
- [X] T007 Implement pure draft/document projection in `backend/src/modules/routines/document/transform.ts`.
- [X] T008 Implement fixture parser/serializer in `backend/src/modules/routines/document/fixture.ts`.
- [X] T009 Add public exports in `backend/src/modules/routines/document/index.ts` and `backend/src/modules/routines/public.ts`.

## Phase 4: Validation

- [X] T010 Run focused backend tests: `cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts`.
- [X] T011 Run backend unit suite: `cd backend && pnpm run test:unit`.
- [X] T012 Record decisions and validation evidence in `specs/082-routines-as-data/slice-doc1-notes.md`.

## Phase 5: Review And Handoff

- [X] T013 Run senior engineer review loop and address blocking findings.
- [X] T014 Run engineering manager delivery pass and address in-scope feedback.
- [ ] T015 Commit locally on `routine-text-composer` with a Conventional Commit message; do not push or open a PR. Deferred to EM per slice 2 handoff instruction.

## Phase 6: Slice 2 Planning And Tests First

- [X] T016 Verify branch `routine-text-composer`, latest migration number on branch and `origin/main`, and slice-1 commit baseline before slice 2 edits.
- [X] T017 Extend `specs/082-routines-as-data/plan-authoring-surface.md` with the slice 2 `default` guard representation, migration number, contract surfaces, docs parity, and queue impact plan.
- [X] T018 Extend `specs/082-routines-as-data/tasks-authoring-surface.md` with slice 2 TDD, implementation, generation, docs, and validation tasks.
- [X] T019 [P] Add failing backend schema parity tests for rejecting `fork`, accepting `default`, and preserving migrated legacy `always`/`fallback` definitions in `backend/tests/unit/routine-definition-service.test.ts`.
- [X] T020 [P] Add failing document round-trip tests replacing `always`/`fallback` with `default` while parsing legacy fixture aliases in `backend/tests/unit/routine-document-roundtrip.test.ts`.
- [X] T021 [P] Add failing pure engine golden test for counter exhaustion forcing the default edge in `packages/conversation-engine/tests/defaultRoutineRunner.test.ts`.

## Phase 7: Slice 2 Schema Cuts

- [X] T022 Remove `fork` from routine domain schemas, compiler metadata behavior, repository parsing, validation fixtures, and OpenAPI registry enums in `backend/src/modules/routines/`, `backend/src/db/repositories/routineDefinitionRepository.ts`, and `backend/src/app/http/openapi/schemas/agentSchemas.ts`.
- [X] T023 Replace authored `always`/`fallback` guard kinds with `default` in routine domain schemas, compiler, validator, document transform/fixture modules, and backend tests under `backend/src/modules/routines/` and `backend/tests/unit/`.
- [X] T024 Update pure engine contract/runtime to use `RoutineGuard { kind: "default" }` and derive old always-vs-fallback behavior from sibling context in `packages/conversation-contract/index.d.ts` and `packages/conversation-engine/src/routineRunner.ts`.
- [X] T025 Add startup-safe migration `backend/src/db/migrations/089_routine_default_guard_schema_cut.sql` converting `routine_transition.guard_kind` from `always`/`fallback` to `default` and replacing routine step/transition check constraints without destructive enum drops.
- [X] T026 Regenerate code-first contract artifacts: `backend/openapi.yaml`, `backend/openapi.json`, `typescript-sdk/openapi/radioso.yaml`, `typescript-sdk/openapi/radioso.json`, `typescript-sdk/src/generated/types.ts`, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts`.
- [X] T027 Update docs/spec references that enumerate routine step/guard kinds, including `specs/082-routines-as-data/spec.md`, `specs/082-routines-as-data/amendment-authoring-surface.md`, `specs/082-routines-as-data/plan.md`, and any relevant `docs/` files after reading `docs/document-writer-prompt.md`.

## Phase 8: Slice 2 Validation And Handoff

- [X] T028 Run focused routine definition/document tests and pure engine runtime golden tests.
- [X] T029 Run relevant contract/OpenAPI validation available in the sandbox.
- [X] T030 Run `cd backend && pnpm run test:unit`; record socket/EPERM or other sandbox-limited failures precisely.
- [X] T031 Record implementation decisions, message-queue impact review, and validation evidence in `specs/082-routines-as-data/slice-doc2-notes.md`.
- [X] T032 Run senior engineer review loop and address blocking findings.
- [X] T033 Run engineering manager delivery pass and address in-scope feedback.
- [X] T034 Leave changes uncommitted for EM verification; do not push or open a PR.

## Dependencies

Tests T003-T005 must be authored before implementation T006-T009. Validation T010-T012 depends on implementation. Review and local commit depend on validation.

Slice 2 tests T019-T021 must be authored before implementation T022-T025. Contract generation T026 depends on schema/OpenAPI source edits. Docs T027 and notes T031 depend on final representation decisions. Reviews T032-T033 depend on validation evidence.

## Phase 9: Slice 3 Planning And Tests First

- [X] T035 Verify branch `routine-text-composer`, read amendment §4/§12 item 3, slice-doc1 notes, slice-doc2 notes, frontend local README briefs, and docs writer prompt.
- [X] T036 Extend `specs/082-routines-as-data/plan-authoring-surface.md` and `specs/082-routines-as-data/tasks-authoring-surface.md` for slice 3 boundaries, tests, docs, and validation.
- [X] T037 [P] Add failing adapter round-trip tests in `frontend/tests/unit/routine-outline.test.ts` for outline state → draft → outline state identity across llm/default/outcome/counter guards, handoff ends, loops, action mentions, and legacy normalized values.
- [X] T038 [P] Extend `frontend/tests/e2e/routines-settings.spec.ts` for authoring a multi-step outline routine with branch row, counter, handoff end, absent enum pickers, toggle round-trip, and inline validation on the offending step card.

## Phase 10: Slice 3 Outline Adapter And UI

- [X] T039 Implement the client-only outline projection and diagnostic mapping in `frontend/lib/routine-outline.ts`.
- [X] T040 Add the per-routine outline/form toggle and outline editor controls in `frontend/components/dashboard/settings/assistant-routines-section.tsx`, reusing existing shadcn/Radix primitives and the current authoring APIs.
- [X] T041 Keep save/validate/publish behavior on the existing routine API and ensure switching outline ↔ form projects through one draft without losing data.
- [X] T042 Update `docs/authoring-routines.md` minimally to mention outline authoring alongside the form and correct the current default guard wording.

## Phase 11: Slice 3 Validation And Handoff

- [X] T043 Run focused frontend unit tests for the outline adapter and existing form adapter.
- [X] T044 Run `cd frontend && pnpm test`.
- [X] T045 Run `cd frontend && pnpm run lint`.
- [X] T046 Attempt `cd frontend && pnpm run build` and record the result honestly.
- [X] T047 Record implementation decisions, skipped retirement-trigger instrumentation rationale, and validation evidence in `specs/082-routines-as-data/slice-doc3-notes.md`.
- [X] T048 Leave changes uncommitted for EM verification; do not push or open a PR.

## Phase 12: Slice 4 Planning And Backend Tests First

- [X] T049 Verify branch `routine-text-composer`, read amendment §5/§12 item 4, all prior slice notes, Coach prompt precedent, and the existing routines route/OpenAPI/frontend surfaces.
- [X] T050 Extend `specs/082-routines-as-data/plan-authoring-surface.md` and `specs/082-routines-as-data/tasks-authoring-surface.md` for slice 4 boundaries, contracts, observability, queue review, tests, and validation.
- [X] T051 Add failing backend unit tests in `backend/tests/unit/routine-draft-assist.test.ts` for happy path, schema-mismatch retry, invalid-after-retry author-facing error, and action not in the permitted catalog rejected by validation.
- [X] T052 Add or extend routine authoring contract/OpenAPI tests for `POST /api/v1/agents/{agentId}/routines/draft-assist` request/response shape and authentication.

## Phase 13: Slice 4 Backend Assist Endpoint

- [X] T053 Add prompt asset `backend/prompts/routines/draft-document.md`, following `backend/prompts/coach/draft-directive.md` conventions and instructing multilingual extraction, untrusted input handling, permitted-action catalog limits, and no invented scope.
- [X] T054 Implement `backend/src/modules/routines/assist.ts` with prompt loading, permitted-action catalog handling, provider call, structured JSON parsing, one schema retry, validator invocation, catalog diagnostics, and redacted observability.
- [X] T055 Export the assist service and schemas from `backend/src/modules/routines/public.ts`.
- [X] T056 Wire `RoutineDraftAssistService` into dependency construction using the existing chat inference pipeline and composition action handler registrations; do not add persistence or queue dispatch.
- [X] T057 Add `POST /:agentId/routines/draft-assist` to `backend/src/app/http/routes/agentRoutes.ts` with routine manage auth and a thin handler.
- [X] T058 Register assist request/response schemas and path in the code-first OpenAPI registry, then regenerate backend OpenAPI, TypeScript SDK OpenAPI/types, and MCP generated types.

## Phase 14: Slice 4 Frontend Review-Before-Apply

- [X] T059 Extend frontend routine API types/adapter with `draftRoutineFromProcedure(agentId, { prose })` and unit coverage in `frontend/tests/unit/routines-api.test.ts`.
- [X] T060 Add a pure proposal-to-outline transform test in `frontend/tests/unit/routine-outline.test.ts` proving an assist response draft loads into editable outline state without saving.
- [X] T061 Add the "Draft from procedure" dialog/textarea affordance to the blank new-routine outline view in `frontend/components/dashboard/settings/assistant-routines-section.tsx`, with busy/error state and distinct accessible labels.
- [X] T062 Extend `frontend/tests/e2e/dashboard-fixtures.ts` with a mocked assist response and `frontend/tests/e2e/routines-settings.spec.ts` with the assist journey; no live LLM in e2e.

## Phase 15: Slice 4 Validation And Handoff

- [X] T063 Run focused backend assist tests and relevant contract/OpenAPI checks.
- [X] T064 Run `cd backend && pnpm run test:unit` and record sandbox-limited failures precisely if any.
- [X] T065 Run `cd frontend && pnpm test`.
- [X] T066 Run `cd frontend && pnpm run lint`.
- [X] T067 Record implementation decisions, initial-drafting-only scope, message-queue impact review, observability review, and validation evidence in `specs/082-routines-as-data/slice-doc4-notes.md`.
- [X] T068 Run senior engineer review loop and address blocking findings within slice 4 scope.
- [X] T069 Leave changes uncommitted for EM verification; do not push or open a PR.
