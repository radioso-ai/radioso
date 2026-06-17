# Tasks: Human-in-the-Loop Controls — Tranche A (Approval MVP)

**Input**: Design documents from `/specs/091-human-in-the-loop-approvals/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅
**Scope**: Tranche A only (US1–US3, FR-001…FR-016). Tranche B (US4–US5) is out of scope.

**Tests**: Backend tests are REQUIRED and MUST be written FIRST and FAIL before implementation (constitution II). Frontend user-visible behavior → Playwright; frontend unit tests only for non-visual logic.

**Format**: `[ID] [P?] [Story] Description with file path` — `[P]` = parallelizable (different files, no incomplete deps).

---

## Phase 1: Setup

- [ ] T001 Confirm workspace deps installed (`pnpm install` at repo root) and engine tests run (`cd packages/conversation-engine && pnpm test`); record `INTEGRATION_DATABASE_URL` pointing at the running `radioso-postgres-1` for backend integration/contract lanes.
- [ ] T002 Reserve migration filenames `102_message_source_discriminator.sql` and `104_pending_decisions.sql` under `backend/src/db/migrations/` (latest is `101`). **No `103` needed**: `routine_states.status` is unconstrained `TEXT` (migration 071, no CHECK), so `'suspended'` is insertable as-is, and `expires_at` is already nullable.

---

## Phase 2: Foundational — the engine suspend/resume primitive (Blocking for US1/US2)

**Purpose**: The product-agnostic spine every HITL flavor builds on. Independently testable with engine unit tests (no DB). Resume is spike-proven against the unmodified runner; this phase adds the additive contract + a thin entry point + the suspend-side `await` kind.

**⚠️ CRITICAL**: US1 and US2 depend on this phase. (US3 is independent and may proceed in parallel.)

### Tests (write FIRST, ensure they FAIL)

- [ ] T003 [P] Engine unit tests for `resumeAwaitingDecision` in `packages/conversation-engine/tests/awaitingDecision.test.ts` — approve branches via the `field` guard with **zero** selector calls; reject takes the rejection edge with the gated skill never dispatched; a control routine with `llm` decision edges DOES call the selector (proves causality). Graduates `tests/spike-resume-awaiting-decision.test.ts`.
- [ ] T004 [P] Engine unit test for the suspend side in `packages/conversation-engine/tests/awaitingDecision.test.ts` — a routine turn reaching an `await` step returns `awaitingDecision { handle?, stepId, options, captureKey }`, renders the "awaiting review" reply, and does **not** advance into the gated step.

### Implementation

- [ ] T005 Add contract types to `packages/conversation-contract/index.d.ts`: `RoutineAwaitingDecision`, `DecisionOption`, `awaitingDecision?` on `ConversationRoutineResumeResult`, `RoutineStep.kind |= "await"` + `decision?`, `SuspendedRoutineReader`, `RoutineDecisionInput`, `ConversationRoutineDecisionResult`, `resumeAwaitingDecision` on `ConversationEngine`, `MessageSource` + optional `source?` on message/event, `RoutineTraceStepEntry.event |= "suspended"|"decision_notified"|"decision_applied"`.
- [ ] T006 Implement `packages/conversation-engine/src/awaitingDecision.ts` (pure resume helper, mirrors `clarification.ts`): load by handle → validate option → merge `{[captureKey]:{id,payload}}` into variables → `status="active"` → `routineRunner.resume({turn,state})`.
- [ ] T007 Implement `DefaultConversationEngine.resumeAwaitingDecision` in `packages/conversation-engine/src/index.ts` — wires the helper to the engine's ports; appends **no** synthetic user input event (unlike `attemptRoutine`).
- [ ] T008 Suspend-side detection of the `await` runtime step in `packages/conversation-engine/src/routineRunner.ts` — when a transit walk reaches an `await` step, render the step + return `awaitingDecision` instead of advancing; keep the change minimal (resume path stays unchanged, spike-proven).
- [ ] T009 Verify engine: `pnpm --filter @radioso/conversation-contract run typecheck`, `cd packages/conversation-engine && pnpm exec tsc --noEmit -p tsconfig.json && pnpm test` — T003/T004 green. (Do NOT run `pnpm run build`.)

**Checkpoint**: the engine can suspend at an `await` step and resume from an injected decision, fully unit-tested.

---

## Phase 3: User Story 1 — Gated approval suspends → operator decides → resume (Priority: P1) 🎯 MVP

**Goal**: A routine author gates a side-effecting step; reaching it suspends durably; an authorized operator approves/rejects via an authenticated endpoint; approve resumes & runs the action exactly once, reject takes the rejection path.

**Independent Test**: Publish a routine with an `approval` step before an action step; drive to the gate (assert not fired + suspended + pending decision); resolve approve (assert resumed at gate, action once) / reject (assert never fired).

### Tests (write FIRST, ensure they FAIL)

- [ ] T010 [P] [US1] Compiler/validator unit tests in `backend/tests/unit/routine-definition-domain.test.ts` — `approval`→`await` compiles with deterministic decision edges + no `collectsSlots` + gate-before-side-effect + one edge per outcome + fallback; validator rejects an `llm` decision edge / a gate after the side effect.
- [ ] T011 [P] [US1] Integration test in `backend/tests/integration/approvals/suspend-commit.test.ts` — reaching the gate persists `routine_states.status='suspended'` + a `pending_decisions` row + an `approval.request` outbox row in one transaction; `loadActive` excludes the suspended routine; the abandon sweep skips it; a forced rollback leaves no orphan decision row.
- [ ] T012 [P] [US1] Integration test in `backend/tests/integration/approvals/decision-resume.test.ts` — approve resumes at the gate and dispatches the gated skill exactly once; reject takes the rejection edge with zero dispatches; unauthorized decider → 403; double-submit → 409 (action not fired twice); stale content hash → 409; decision recorded then crash-before-resume → idempotent on retry, human not re-prompted.
- [ ] T013 [P] [US1] Contract test in `backend/tests/contract/decisions.contract.test.ts` for `POST /api/agents/:agentId/decisions/:handle/resolve` (request/response/status codes) against the generated OpenAPI.

### Implementation

- [ ] T014 [US1] Add `approval` author step kind + compile to runtime `await` + validator invariants in `backend/src/modules/routines/{domain.ts,compiler.ts,validator.ts}`.
- [ ] T015 [US1] `backend/src/db/repositories/routineStateRepository.ts` (NO migration — status is unconstrained TEXT): `save` sets `expires_at = NULL` when `status === 'suspended'` (pause the abandon clock); add `loadSuspended({ sessionId })` (status `'suspended'`, ignore expiry); `loadActive` stays `status='active'`. Mirror the same `expires_at`-when-suspended rule in `postgresAssistantTurnPersistence.saveRoutineState`. **No optimistic `version`**: the suspended row is never a concurrent-write target — `loadActive` excludes it, activation skips when a suspended row exists (FR-004), and resume serializes via the `pending_decisions` CAS inside the atomic resolve+resume+persist tx. (Optimistic versioning is deferred as future hardening.)
- [ ] T016 [US1] Migration `104_pending_decisions.sql` (sibling of `routine_action_requests`; unique `handle`; one-open-per-gate partial unique index; queue + deadline indexes) + `backend/src/db/repositories/pendingDecisionRepository.ts` (`create`, `loadByHandle`, `resolve` CAS, `listPending`).
- [ ] T017 [US1] New module `backend/src/modules/approvals/{public.ts,domain.ts,service.ts}` — decision domain (option-in-set, content-hash, decider-scope) + service (validate → record CAS → invoke `ResumeRunner` port); no chat-internal imports.
- [ ] T018 [US1] Extend `backend/src/modules/chat/services/deferredRoutineStore.ts` + `infra/postgresAssistantTurnPersistence.ts` to park-and-persist the suspended state + pending-decision row atomically in `completeAssistantTurn`; add the `chat.suspended` non-answer outcome + `hitl.decision` audit + the new trace events in `chatTurnLifecycle.ts`.
- [ ] T019 [US1] Implement `resumeAwaitingDecisionTurn` in `backend/src/modules/chat/services/chatService.ts` (load suspended → `engine.resumeAwaitingDecision` → `completeAssistantTurn`); thin delegation only.
- [ ] T020 [US1] Add `backend/src/app/http/routes/decisionRoutes.ts` (validated submit: open / member / decider-scope / hash / option). **Crash-safe (review P1(b))**: run `pendingDecisionRepository.resolve(input, txClient)` + `engine.resumeAwaitingDecision` + the resumed-turn persist in ONE `withTransaction` (resolve uses the tx client, not its own commit); the gated effect is an idempotent outbox `action` enqueued in that tx, never a synchronous skill. Register in `backend/src/app/http/openapi/document.ts`; regenerate `backend/openapi.{yaml,json}`, `typescript-sdk` (`pnpm run sync`), MCP (`sync:openapi`).
- [ ] T021 [US1] Add `backend/src/app/composition/builtIn/approvalModule.ts` — construct `PendingDecisionRepository` + bind the `ResumeRunner` port to chat's resume; register in default composition (mirrors `contactRoutineModule.ts`).
- [ ] T022 [US1] Verify: `backend` unit + targeted integration (T010–T013) green via `pnpm exec vitest run <path>`; OpenAPI contract check (`pnpm run check:api-contracts`).

**Checkpoint**: the full approve/reject→resume loop works end-to-end via the endpoint (MVP).

---

## Phase 4: User Story 2 — Operator queue + out-of-band notification (Priority: P2)

**Goal**: Pending decisions surface in the dashboard queue with enough context to decide; a notification reaches the configured recipient with a link; approve/reject from the queue drives the same endpoint.

**Independent Test**: Create a pending decision → assert a notification dispatched with a handle link; open the queue → assert the row with proposed action / reason / deadline; approve from the queue → row leaves the pending list.

### Tests (write FIRST)

- [ ] T023 [P] [US2] Integration test in `backend/tests/integration/approvals/notify.test.ts` — the `approval.request` action routes through the worker to the contact-delivery resolver; re-notify reuses the decision row with a fresh de-duplicated nudge.
- [ ] T024 [P] [US2] Playwright `frontend/tests/e2e/approvals.spec.ts` — operator opens Quality "needs approval", approves, and the conversation resumes (read-for-all, act-for-deciders, no double-handling).

### Implementation

- [ ] T025 [US2] `backend/src/modules/chat/services/actions/approvalRequestActionHandler.ts` + register via `registerActionHandler` in `approvalModule.ts` (mirror `contactSendActionHandler`); emit the `approval.request` action on suspend.
- [ ] T026 [US2] Quality-view "needs approval" signal tile + filter + per-row approve/reject in `frontend/components/dashboard/quality-view.tsx`; adapter `frontend/lib/api-approvals.ts` (optimistic, revert on failure).
- [ ] T027 [US2] Queue docs + `approval.request` payload note + message-queue impact review write-up (retry/lease unchanged).
- [ ] T028 [US2] Verify US2 tests green.

**Checkpoint**: an operator can take a conversation pending → resumed entirely from the dashboard.

---

## Phase 5: User Story 3 — Message source discriminator (Priority: P3, independent)

**Goal**: Every persisted message records who produced it; operators see it. Non-breaking; no dependency on the HITL spine (may be done in parallel from the start).

**Independent Test**: Send a normal conversation → every message has a `source`; old rows read back a role-derived source; the dashboard renders it.

### Tests (write FIRST)

- [ ] T029 [P] [US3] Persistence-mapper unit test in `backend/tests/unit/message-source.test.ts` (write-through + role→source backfill on read) + migration round-trip.
- [ ] T030 [P] [US3] Frontend unit test for the source-badge transform (non-visual data mapping) in `frontend/tests/unit/message-source.test.ts`.

### Implementation

- [ ] T031 [US3] Migration `102_message_source_discriminator.sql` (`source TEXT`, unconstrained) + stamp `source` in `backend/src/modules/chat/infra/postgresAssistantTurnPersistence.ts` + `chatSessionPreparer.ts` (`user→customer`, `assistant→ai_agent`, `system`); read derives from role for old rows.
- [ ] T032 [US3] Add `MessageSource` (full union incl. reserved `human_agent_on_behalf_of_ai_agent`) + optional `source` to message responses in `backend/src/app/http/openapi/document.ts`; regenerate OpenAPI + SDK + MCP (additive/optional).
- [ ] T033 [US3] Render `source` in `frontend/components/dashboard/conversation-drawer.tsx` + `chat-message-thread.tsx` (read-only attribution).
- [ ] T034 [US3] Verify US3 tests green.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T035 [P] Docs: `approval` step in routine authoring docs; operator approval-queue guide; `source` field + decision endpoint in API/SDK/MCP docs (read `docs/document-writer-prompt.md` first for product-surface docs).
- [ ] T036 Run `quickstart.md` validation end-to-end against a local stack.
- [ ] T037 `pnpm run ci:local -- origin/main` (use `--all` for the broad backend+frontend change); include the result in the PR body.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → no deps.
- **Phase 2 (Foundational engine)** → after Setup. **Blocks US1, US2.** (US3 does not depend on it.)
- **US1 (Phase 3)** → after Phase 2. The MVP.
- **US2 (Phase 4)** → after US1 (reuses `pending_decisions` + the endpoint + the outbox spine).
- **US3 (Phase 5)** → independent; can run in parallel from the start (its own migration + surfaces).
- **Polish (Phase 6)** → after the desired stories.

### Within each story
- Backend tests FAIL-first (T010–T013, T023, T029 before their impl).
- Models/migrations + repositories before services; services before endpoints; endpoints before composition wiring.
- Keep `chatService.ts` thin (delegate); do not extend the outbox into a decision store; keep the engine product-agnostic.

### Parallel opportunities
- Phase 2 tests (T003, T004) in parallel.
- US3 (Phase 5) in parallel with Phase 2 / US1 (no shared files except `openapi/document.ts` + regen — sequence the regen tasks T020/T032 to avoid a conflict).
- Within US1, tests T010–T013 in parallel; migrations T015/T016 in parallel (different files).

## Implementation Strategy

- **MVP** = Phase 1 + Phase 2 + US1 (Phase 3): the full suspend→decide→resume loop via the endpoint. Stop and validate against SC-001…SC-008.
- **Then** US2 (operator UX) → US3 (attribution) → Polish.
- Delegate coding slice-by-slice to Codex CLI agents (engine slice first — no DB, no build); the orchestrator independently verifies every slice (`tsc --noEmit` + `vitest`/Playwright), never trusting self-reports. **Do not let Codex run `pnpm run build`** (sandbox dist EPERM hang) — verify with `tsc --noEmit`/tests.

## Notes
- Verify tests fail before implementing.
- Commit after each logical group (when the user approves committing).
- The seed test `packages/conversation-engine/tests/spike-resume-awaiting-decision.test.ts` graduates into T003.
