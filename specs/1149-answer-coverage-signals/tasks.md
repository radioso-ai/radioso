# Tasks: Answer Coverage Signals

## Dependencies

Foundation (T001–T009) precedes all user stories. US1 establishes the shared
record and runtime signal; US2 consumes it; US3 and US4 project the same
persisted record. Documentation and generated contracts follow their owners.

## Phase 1 — Setup and design

- [X] T001 Record coverage module boundaries, request/turn correlation, observability, queue-impact, and copilot descriptor decision in `specs/1149-answer-coverage-signals/plan.md`
- [X] T002 [P] Add shared assessment contract and strict schema red tests in `backend/tests/unit/answerCoverage/answerCoverageSchema.test.ts`
- [X] T003 [P] Add Pulse coverage aggregation and legacy compatibility red tests in `backend/tests/unit/audiencePulse/coverageAggregation.test.ts`
- [X] T004 [P] Add directive/routine coverage-criteria and suppression-policy red tests in `backend/tests/unit/directives/coverageCriteria.test.ts` and `backend/tests/unit/routines/coverageActivation.test.ts`

## Phase 2 — Foundational assessment and storage

- [X] T005 Implement the engine/backend shared provider-neutral runtime contract in `packages/conversation-contract/` and backend validated semantic producer in `backend/src/modules/answerCoverage/`
- [X] T006 Extend the existing immutable turn-trace/history durability path first; add a Kysely migration, repository ports, row mappers, and idempotent adapters only for Pulse/retry data the trace cannot durably project in `backend/src/db/`
- [X] T007 Add repository migration/idempotency red-green coverage in `backend/tests/integration/answerCoverage/`
- [X] T008 Wire assessment producer and repositories through `backend/src/app/composition/` and server builders; add composition coverage in `backend/tests/unit/composition/`
- [X] T009 Add bounded trace/telemetry fields for assessment availability and reaction outcome in the owning conversation instrumentation modules

## Phase 3 — User Story 1: accurate answer coverage

- [X] T010 [US1] Add chat/engine orchestration tests for evidence-gap, partial, explicit negative, ambiguity, conflict, invalid assessment, and streaming parity in `backend/tests/unit/chat/` and `backend/tests/integration/chat/`, including retrieval → assessment → coverage directive/routine attempt → first streamed text
- [X] T011 [US1] Integrate assessment after evidence and before final response commitment in `backend/src/modules/chat/` and the conversation-engine boundary
- [X] T012 [US1] Persist and expose originating request/turn provenance without letting semantic coverage bypass grounding validation in `backend/src/modules/chat/` and history projection owners
- [X] T013 [US1] Add deterministic multilingual coverage eval cases in `backend/tests/unit/eval-suite/`

## Phase 4 — User Story 2: authored directives and routines

- [X] T014 [US2] Extend directive/routine authoring schemas, APIs, copilot descriptor coverage, and validation with typed coverage/reason criteria in `backend/src/modules/directives/`, `backend/src/modules/routines/`, and `backend/src/modules/operatorCopilot/`
- [X] T015 [US2] Pass narrow coverage context to directive matching and routine activation with bounded deterministic precedence and duplicate suppression in `backend/src/modules/directives/` and `backend/src/modules/routines/`
- [X] T016 [US2] Persist reaction decisions and generic routine lifecycle links in `backend/src/modules/answerCoverage/` and repository adapters, including accepted/declined offers, retry idempotency, active-routine suppression, and absent-trigger legacy routine activation
- [X] T017 [US2] Add existing authoring UI controls and Playwright journey for different operator reactions in `frontend/components/` and `frontend/tests/e2e/`

## Phase 5 — User Story 3: Audience Pulse

- [X] T018 [US3] Add fixed-population Pulse aggregation tests for exclusive buckets, reason eligibility, recurrence threshold, duplicate events, mixed legacy records, and routine completion in `backend/tests/unit/audiencePulse/`
- [X] T019 [US3] Implement recorded assessment Pulse projection, recurrence calculation, authorized evidence, and legacy disclosure in `backend/src/modules/audiencePulse/`
- [X] T020 [US3] Expose topic coverage summaries and evidence through HTTP/OpenAPI in `backend/src/app/http/` and add contract tests in `backend/tests/contract/`
- [X] T021 [US3] Add Audience Pulse topic/evidence UI and Playwright coverage in `frontend/components/dashboard/` and `frontend/tests/e2e/`

## Phase 6 — User Story 4: turn diagnostics

- [X] T022 [US4] Add actual chat-history/debug projection tests for assessed, absent, failed, directive/routine decision, and later routine lifecycle states in `backend/tests/unit/chat/`
- [X] T023 [US4] Implement authorized debug/history projection and recorded trace navigation in `backend/src/modules/chat/` and `backend/src/app/http/presenters/`
- [X] T024 [US4] Add turn-debug UI and Playwright coverage for evidence/citation/coverage distinction and suppressed duplicate reactions in `frontend/components/dashboard/` and `frontend/tests/e2e/`

## Phase 7 — Contract, docs, and verification

- [X] T025 Update `backend/src/app/http/openapi/document.ts`, regenerate `backend/openapi.yaml` and `backend/openapi.json`, run `cd typescript-sdk && pnpm run sync`, and commit generated SDK changes
- [X] T026 Read `docs/document-writer-prompt.md` and update directive/routine authoring, diagnostics, Audience Pulse, and public API documentation in `docs/` and `docs-portal/content/`
- [X] T027 Update applicable module `README.md` briefs and code map ownership only where public entry points or recurring test paths changed
- [X] T028 Run focused red-green tests, backend/frontend builds, API contracts, SDK tests, Playwright, `pnpm run lint`, and `pnpm run lint:dead-code:ci`; mark completed tasks with `[X]`
- [X] T029 Complete independent senior-engineer review, resolve findings, rerun affected checks, and hand off for engineering-manager review

## Verification recorded before final gates

Focused engine (44), authoring database (25), coverage database (3), and
authoring/debug/Pulse UI checks passed. The backend unit suite passed 595 files
and 5,796 tests; combined database integration passed 3 files and 28 tests.
The contract snapshot is current. Root-owned lint, dead-code, production build,
and browser checks remain pending before T028 is marked complete.
