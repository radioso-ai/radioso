# Tasks: Clarification Capability

**Input**: Design documents from `/specs/085-clarification-capability/`
**Prerequisites**: plan.md, spec.md (rev 2), research.md (R1–R10), data-model.md, quickstart.md

**Tests**: Backend TDD is mandatory — every backend slice writes failing Vitest
tests before implementation. Frontend: unit tests for the turn-flow/turn-trace
transforms (non-visual), Playwright for the operator trace journey.

**Architecture**: Preserve plan.md module ownership. `chatService.ts`,
`chatTurnLifecycle.ts`, `routineRegistry.ts`, `turn-flow.ts` are
responsibility-limited; new domain logic goes in the new named modules.

## Phase 1: Setup

- [X] T001 Verify branch `085-clarification-capability` is current and `pnpm install` is clean at repo root (no code changes; baseline `pnpm run ci:local -- origin/main` optional but record any pre-existing failures, cf. flaky websiteCrawler DELETE test)

## Phase 2: Foundational (blocking prerequisites for all stories)

**Generic Clarifier + pending-state plumbing — no detector knowledge anywhere in this phase.**

- [X] T002 [P] Add clarification contract types to `packages/conversation-contract/index.d.ts`: `ClarificationCandidate`, `ClarificationPolicy`, `ClarificationDecision`, `PendingClarification`, `ConversationClarificationStore`, clarifier LLM ports (`phraseQuestion`, `mapReply`) per data-model.md; version-note the upcoming `ConversationRoutineActivator` union change in the file header (do not change the activator yet — that's US1)
- [X] T003 [P] Write failing unit tests for pure decide logic in `packages/conversation-engine/tests/clarification.test.ts`: floor filtering, clear-margin auto-pick, too-close → ask, maxOptions cap, deterministic ordering (confidence desc → priority desc → id), suppressed mode, loop-guard suppression input, FR-014 none-outcome
- [X] T004 Implement `packages/conversation-engine/src/clarification.ts`: pure `decideClarification(candidates, policy, context)` + `clarificationStage(...)` trace-stage builder (metadata-safe outputs per data-model.md; no payloads in trace) — make T003 green; export from package index
- [X] T005 [P] Write failing tests for the LLM clarifier in `packages/conversation-defaults/tests/clarifier.test.ts` (fake `ConversationModelGateway`): question phrased from labels/descriptions only, reply mapping to chosen/declined/unrelated, malformed model output → safe `unrelated`
- [X] T006 Implement `packages/conversation-defaults/src/clarifier.ts` (`DefaultClarifier`: gateway + injected prompt-template strings, mirroring `routineNextStepSelector.ts` style) — make T005 green
- [X] T007 [P] Add prompt templates `backend/prompts/chat/clarification-question.md` and `backend/prompts/chat/clarification-reply-map.md` (LLM-phrased, conversation-language, JSON reply-map output schema; no hard-coded user-facing strings in code)
- [X] T008 [P] Write failing repository tests in `backend/tests/integration/clarification-state-repository.test.ts`: save/loadPending/clear lifecycle, single-pending-per-session upsert, TTL expiry → `expired`, non-pending row visible for loop guard until TTL
- [X] T009 Create migration `backend/src/db/migrations/087_clarification_states.sql` (schema per data-model.md, partial pending index; number must be the next free one — re-check `ls backend/src/db/migrations` before landing) and implement `backend/src/db/repositories/clarificationStateRepository.ts` implementing `ConversationClarificationStore` — make T008 green
- [X] T010 [P] Write failing unit tests in `backend/tests/unit/deferred-clarification-store.test.ts` (command-capture: save/clear captured not written, commit flushes, consumeTransition) and `backend/tests/unit/chat-turn-lifecycle.test.ts` additions: clarification transition commits atomically through the transaction port AND the fallback path; SC-008 failure-before-commit leaves no pending row
- [X] T011 Implement `backend/src/modules/chat/services/clarification/deferredClarificationStore.ts`; extend `AssistantTurnPersistence.completeAssistantTurn` input + `PostgresAssistantTurnPersistence` + `chatTurnLifecycle.ts` (both paths) to carry the captured clarification transition — make T010 green; keep lifecycle changes transport-free and thin
- [X] T012 Add `clarification_decisions_total` counter helper (surface × decision labels) in `backend/src/modules/chat/services/clarification/clarificationMetrics.ts` using `metricsRegistry.incrementCounter`, with a unit test in `backend/tests/unit/clarification-metrics.test.ts` (no content-bearing labels)

**Checkpoint**: generic Clarifier provable with a fake candidate set; pending state commits atomically; no detector exists yet.

## Phase 3: User Story 1 — Routine activation clarification (P1) 🎯 MVP

**Goal**: ranked one-call activation; too-close + priority-tied → ask; reply starts chosen routine with variables; clear winner/priority → silent (SC-001/003/004).

**Independent Test**: quickstart.md US1 — two overlapping published routines: ambiguous → question; choice → routine starts; targeted → silent start; priority tie-break silent.

### Tests first (write, ensure failing)

- [X] T013 [P] [US1] Failing unit tests for the ranked matcher in `packages/conversation-defaults/tests/routineRegistry.test.ts`: one gateway call for N registrations, structured ranked output parsing, floor/margin/priority decision order (spec FR-007 order), deterministic ordering, activation variables captured per candidate, malformed output → null (no activation); update existing first-match tests to the new contract instead of deleting them
- [X] T014 [P] [US1] Failing engine tests in `packages/conversation-engine/tests/defaultConversationEngine.test.ts` additions: activator `clarify` outcome → engine asks via clarifier port, appends question response event, emits `clarification` spine stage, saves pending via store port, claims turn without starting a routine; `activate` outcome unchanged behavior
- [X] T015 [P] [US1] Failing host integration tests in `backend/tests/unit/chat-clarification-resolve.test.ts`: pending routine-activation clarification + reply → mapReply chosen → forced activation starts chosen routine with stored variables (no extra activation model call); declined → cleared + normal turn; unrelated → cleared + normal turn; loop guard: matching recently-declined candidate set → suppressed ask (auto-pick) ; resolve-then-new-ask same turn is impossible (FR-006)
- [X] T016 [P] [US1] Failing test updates for contact routine registration in `backend/tests/unit/` (contact activation through the ranked matcher: positive and negative activation cases preserved from `contactActivationClassifier` tests)

### Implementation

- [X] T017 [US1] Change `ConversationRoutineActivator.activate` in `packages/conversation-contract/index.d.ts` to the outcome union (`activate` | `clarify` | null) per data-model.md
- [X] T018 [US1] Rework `packages/conversation-defaults/src/routineRegistry.ts`: `RoutineRegistration` → declarative `{ routine, trigger: { description, priority } }`; implement single-call ranked matcher (gateway + injected `routine-ranked-activation` template) + pure decision order via `decideClarification` — make T013 green
- [X] T019 [P] [US1] Add prompt template `backend/prompts/chat/routine-ranked-activation.md` (all triggers in one prompt; per-routine confidence + extractable variables; structured JSON output)
- [X] T020 [US1] Engine ask-path in `packages/conversation-engine/src/index.ts` `attemptRoutine`: handle `clarify` outcome (clarifier ports + clarification store in `AttemptRoutineInput`), emit stage, save pending (deferred), return claimed turn — make T014 green
- [X] T021 [US1] Implement `backend/src/modules/chat/services/clarification/pendingClarificationResolver.ts` (load pending → mapReply → outcome routing incl. forced-activation activator wrapper for routine source) and add the single resolve-pending step to `ChatService.answerWithinTrace` + `streamAnswerWithinTrace` in `backend/src/modules/chat/services/chatService.ts`; thread clarification ports through `conversationProcessTurnInput.ts` — make T015 green; chatService gains orchestration only
- [X] T022 [US1] Migrate built-in contact routine registration (`backend/src/modules/chat/services/routines/contactRoutine.ts` + composition `routineRegistrations`) and published-routine source (`backend/src/app/composition/routineDefinitionSource.ts`) to trigger metadata; retire `contactActivationClassifier` and the per-routine `chat/routine-data-activation.md` prompt usage — make T016 green
- [X] T023 [US1] Wire it all in `backend/src/app/server/dependencyBuilders.ts`: DefaultClarifier (question + reply-map templates), per-surface policy constants (research R9), clarification store + deferred wrapper into the turn, ranked matcher into `routineProvider.forTurn`, counters at decision points
- [X] T024 [US1] Run and pass: `pnpm --filter @radioso/conversation-contract run build`, engine + defaults package tests, `cd backend && pnpm run test:unit && pnpm run test:integration`; verify SC-004 (matcher tests assert one gateway call for 10 registrations)

**Checkpoint**: US1 demoable end-to-end per quickstart; suppressed-ask is inert here (asks only fire when no routine active by construction of the activation path).

## Phase 4: User Story 2 — Retrieval sense clarification (P2)

**Goal**: post-retrieval sense-split detection; ask when groups are comparable; chosen sense constrains grounding (SC-002); suppressed while a routine is active; standalone retrieval surfaces untouched.

**Independent Test**: quickstart.md US2 — two-sense corpus: ambiguous → question; choice → sense-constrained citations; unambiguous → no question; in-routine off-topic ambiguous → suppressed.

### Tests first (write, ensure failing)

- [X] T025 [P] [US2] Failing unit tests for grouping in `backend/tests/unit/sense-grouping-service.test.ts`: document-share precondition (≥2 groups ≥ minGroupShare of top-K), embedding-separation check invoked only on qualifying splits (fake embedding reader), candidate construction with `{documentIds}` payload + LLM labels from titles/metadata only, non-qualifying sets → no candidates, deterministic group ordering
- [X] T026 [P] [US2] Failing unit tests for `documentScope` in `backend/tests/unit/retrieval-pipeline-stages.test.ts` additions (or new `document-scope-filter.test.ts`): post-retrieval allow-list filter applied at candidate preparation before rerank; absent scope → identical behavior (SC-003)
- [X] T027 [P] [US2] Failing integration tests in `backend/tests/unit/retrieval-sense-clarification.test.ts`: ambiguous retrieval turn → ask outcome (question, pending saved with `retrieval_sense` source, no grounded answer); resolving turn → documentScope set from payload, citations confined to chosen group; active-routine yielded turn → suppressed (auto-pick top group, trace decision `suppressed`); standalone `/retrieval/answer` path never invokes the detector
- [X] T028 [P] [US2] Failing fixture-based test data: add two-sense corpus fixtures (hatha/raja yoga style) under `backend/tests/fixtures/` for T025/T027 reuse

### Implementation

- [X] T029 [US2] Implement `backend/src/modules/retrieval/services/senseGroupingService.ts` (grouping + pgvector embedding-separation reader port + LLM label call via gateway + `clarification-sense-labels` template) — make T025 green
- [X] T030 [P] [US2] Add prompt template `backend/prompts/chat/clarification-sense-labels.md` (group labels/descriptions from document titles/metadata; conversation language)
- [X] T031 [US2] Add `documentScope?: string[]` to `RetrievalPipelineRequest` in `backend/src/modules/retrieval/public.ts` and apply it in `backend/src/modules/retrieval/services/candidatePreparationStage.ts` — make T026 green
- [X] T032 [US2] Integrate detection into the conversational retrieval turn (retrieval.answer execution path, post-retrieval pre-compose): detector candidates → `decideClarification` (suppressed mode when routine state active) → ask outcome carries candidates so the composer renders the clarifier-phrased question; pending save via the deferred store; resolver (T021) routes `retrieval_sense` resolutions to documentScope — make T027 green; keep detection out of `queryRewriteService.ts` and orchestration out of the retrieval module
- [X] T033 [US2] Extend composition wiring in `backend/src/app/server/dependencyBuilders.ts` for the sense detector (policy constants, embedding reader, prompt template) and confirm standalone retrieval surface gets no detector
- [X] T034 [US2] Run and pass backend unit + integration suites; verify SC-002 citation confinement assertion and SC-003 unchanged-path assertions

**Checkpoint**: both detectors live on the shared Clarifier; US1 unaffected (re-run US1 tests).

## Phase 5: User Story 3 — Operator explainability (P3)

**Goal**: clarification decisions visible as first-class turn-flow nodes with detail panel (SC-005), content-safe.

**Independent Test**: quickstart.md US3 — asked/auto-picked/suppressed turns each render a Clarification node with candidates, decision, reason, mapping outcome.

### Tests first

- [X] T035 [P] [US3] Failing frontend unit tests in `frontend/tests/unit/turn-flow.test.ts` + `frontend/tests/unit/turn-trace.test.ts`: `clarification` stage → first-class flow node (label, detail ref), label mapping, graph edges around the node for both claimed-turn (ask) and pass-through (auto-pick) shapes
- [X] T036 [P] [US3] Failing/extended Playwright spec in `frontend/tests/e2e/assistant-history.spec.ts` (or focused new spec): operator opens debug view of a clarification turn → Clarification node visible → detail shows candidates + decision (use the existing trace-fixture pattern of that spec)

### Implementation

- [X] T037 [US3] Add `clarification` to the stage label map in `frontend/lib/turn-trace.ts` and the flow-graph node construction in `frontend/lib/turn-flow.ts` — make T035 green
- [X] T038 [US3] Add `ClarificationStageDetail` renderer in `frontend/components/dashboard/spine-stage-detail.tsx` (candidates with labels/confidence, decision, reason, mapping outcome; no payloads) — make T036 green
- [X] T039 [US3] Run `cd frontend && pnpm test && pnpm run lint`; run the trace-view Playwright spec

**Checkpoint**: all three stories independently validated.

## Phase 6: Polish & Cross-Cutting

- [X] T040 [P] Docs (read `docs/document-writer-prompt.md` first): update `docs/architecture/assistant-turn-spine.md` (clarification stage, resolve-pending ordering, suppressed-ask rule) and `docs/architecture/conversational-routines.md` (ranked one-call activation replaces first-match; trigger metadata registration)
- [X] T041 [P] Docs portal: add clarification behavior + debug-view entry under `docs-portal/content/` (operator-facing: when the assistant asks, how to read the trace); verify `cd docs-portal && pnpm run build`
- [X] T042 [P] Update local briefs if ownership moved: `docs/architecture/code-map.md` conversation-engine + retrieval entries (new clarification module, senseGroupingService)
- [X] T043 Re-affirm in PR body: message-queue impact none; OpenAPI unchanged (open stage kind); no `.env` changes; observability = trace stage + `clarification_decisions_total`
- [X] T044 Multilingual test pass (SC-006): non-English question phrasing + reply mapping covered in T005/T015 fixtures across ≥2 languages — verify present, add if missed
- [X] T045 Run full `pnpm run ci:local -- origin/main`; investigate failures against clean origin/main before attributing (CI latent-breakage memory); record results for the PR body
- [ ] T046 Execute quickstart.md manual validation (US1/US2/US3) against `./run-dev.sh` stack; capture evidence for the PR

## Dependencies & Execution Order

- Phase 2 blocks everything; within it: T002 → (T003→T004, T005→T006), T008→T009, T010→T011; T007/T012 parallel.
- US1 (Phase 3) blocks US2's resolver reuse (T021 is shared) — US2 otherwise independent; US3 depends on stage emission from US1 (T020) but its frontend transforms can be built against fixture envelopes in parallel after data-model.md stage shape is fixed.
- Recommended order: Phase 2 → US1 (MVP, validate) → US2 (validate) → US3 → Polish.

## Parallel Opportunities

- Phase 2: T003/T005/T007/T008/T010/T012 across different files.
- US1 tests T013–T016 in parallel; T019 parallel to T018.
- US2 tests T025–T028 in parallel; T030 parallel to T029.
- US3 T035/T036 in parallel.
- Polish T040–T042 in parallel.

## Implementation Strategy

MVP = Phase 2 + US1 (proves Clarifier, pending lifecycle, ranked activation, ask/map/resume end-to-end). Stop and validate per quickstart before US2. Each later story adds a consumer without touching the Clarifier core — if it does, the abstraction failed; surface it instead of patching through.
