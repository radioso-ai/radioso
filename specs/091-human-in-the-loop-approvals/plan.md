# Implementation Plan: Human-in-the-Loop Controls — Tranche A (Approval MVP)

**Branch**: `091-human-in-the-loop-approvals` | **Date**: 2026-06-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/091-human-in-the-loop-approvals/spec.md`

**Scope of this plan**: **Tranche A only** — User Stories 1–3, Functional Requirements FR-001…FR-016. Tranche B (takeover / hand-back / cursor event stream, US4–US5, FR-017…FR-024) is intentionally **out of this plan** and will be planned separately once Tranche A lands; the spec keeps Tranche B in-document only so Tranche A's schema, attribution, and audit choices stay compatible with it.

## Summary

Deliver the durable **suspend → decide → resume** primitive for routines and the minimum operator surface to use it. A routine author places an `approval` step before a side-effecting step; reaching it durably **suspends** the routine (the side effect does not run) and renders an LLM-authored "awaiting review" reply; an authorized operator approves/rejects from a dashboard queue (or via an authenticated endpoint); approval resumes the routine **at the gated step** and runs the action exactly once, rejection follows the authored rejection edge. Every message also records **who produced it** (`source`).

**Technical approach (validated by the spike, `.context/hitl-spike-runner-resume.md`)**: the *existing* `DefaultRoutineRunner.resume()` already resumes from an injected decision variable with **no source change and no model call** when the gate's edges are deterministic `field`/`slot_filled` guards. So the engine work is additive contract + a thin `resumeAwaitingDecision` entry point (which, unlike `attemptRoutine`, appends **no** synthetic user event) + an `await` step kind for the suspend side. The host work is a **new `pending_decisions` store** (sibling of the conversation-actions outbox — a decision is not a dispatch), a `suspended` routine-state status + optimistic `version`, an atomic suspend-commit through the existing deferred-commit fence, an authenticated validated decision endpoint, an `approval.request` notification action handler (registered exactly like `contact.send`), and the per-message `source` discriminator. The operator queue is layered into the existing Quality view (poll-based; no realtime in Tranche A).

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24 (backend, engine packages); TypeScript 5.7 / React 19 / Next.js 16 App Router (frontend).
**Primary Dependencies**: Express, Zod, Pino, `pg`; `@radioso/conversation-contract` + `@radioso/conversation-engine` + `@radioso/conversation-defaults`; existing conversation-actions outbox; existing per-agent contact-delivery transport.
**Storage**: PostgreSQL 16 (with `pgvector`, not exercised by this feature). New table `pending_decisions`; altered `messages` (+`source`) and `routine_states` (+`suspended` status, +`version`). Next migration numbers from **102** (latest is `101_agent_skills_generic_targets.sql`).
**Testing**: Vitest (engine unit, backend unit/integration/contract), Supertest (HTTP), Playwright (operator queue journey, source rendering). TDD: failing tests first.
**Target Platform**: Linux server (Docker Compose locally via `./run-dev.sh`); browser dashboard + embed.
**Project Type**: web (backend + frontend + workspace packages).
**Performance Goals**: suspend adds one DB transaction per gate (folded into the existing turn commit); **resume is deterministic — zero LLM round-trips** (spike-proven); decision endpoint is a single validated transaction; operator queue refresh is polling (20–30s), no new realtime infra.
**Constraints**: exactly-once decisions (CAS + content-hash binding); the gated side effect MUST NOT run before approval and MUST run exactly once after; a suspended routine survives an inbound user turn and the 30-min abandon sweep; a suspended turn is a non-answer outcome (not billed as an answer); resume must land on the gate step and re-run no prior step.
**Scale/Scope**: per-conversation, low-volume approvals (human-scale, minutes not ms); workspace-scoped queue.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — still passing.*

- **Spec-first (I)**: Spec exists (`spec.md`, rev 2) and gates this plan. Every FR/US below traces to it. ✅
- **Backend TDD (II)**: The suspend→decide→resume loop is an integration-test deliverable (US1 Independent Test); engine additions are unit-tested (the spike seed test is the start). Tests authored failing-first. ✅
- **Stack discipline (III)**: Node.js backend, React frontend, PostgreSQL/pgvector. LLM provider **GPT-5.2** default — note Tranche A adds **no new model call** (the "awaiting review" reply uses the existing routine step renderer; resume branches deterministically). ✅
- **Secrets (IV)**: The resume-handle secret (if derived rather than random) follows the existing `WORKSPACE_TOKEN_SECRET` pattern; `.env.example` updated only if a new secret is introduced (default: random opaque handle, no new secret). ✅
- **UI consistency (V)**: The approval queue extends the existing Quality view's badge/triage/signal patterns and design tokens; no new visual conventions. ✅
- **Modularity (VI)**: New focused `approvals` module owns the pending-decision domain + store; the engine primitive stays product-agnostic; chat orchestration stays orchestration-only; composition wires the notification handler and the resume-runner binding. See Module Ownership & Seams. ✅
- **Customer data (VII)**: Decision endpoint enforces decider scope server-side; resume handle is unguessable/single-use and never the conversation id; audit + trace record step ids / gate reason / option id / decider identity / content hash — never raw prompts, completions, retrieved chunks, or captured slot values. Fail-safe: a decision can never auto-approve in Tranche A (no timeout sweep; overdue items stay resolvable). ✅
- **Code-first API contracts (VIII)**: The decision endpoint + the message `source` field are defined in `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml`/`.json` are regenerated, never hand-edited; contract tests aligned. **Message-queue impact review**: one new outbox action **type** (`approval.request`) — payload documented in queue docs/tests; retry/lease semantics reuse the existing claim/lease path unchanged; no document-worker dispatch or AMQP payload change. ✅
- **Documentation parity (IX)**: Authoring docs gain the `approval` step; operator docs gain the approval queue; API/SDK/MCP docs gain the `source` field and the decision endpoint. Listed as tasks. ✅
- **Prompt assets (X)**: No new runtime prompt is strictly required (the "awaiting review" render reuses the routine step renderer + steering). If planning adds a dedicated render prompt, it lives under `backend/prompts/`. ✅
- **Frontend testing (XI)**: Operator queue journey + source rendering covered by Playwright; unit tests limited to the queue/event data mappers. ✅
- **Composition ownership**: The `approval.request` action handler, the pending-decision repository, and the resume-runner port binding are wired in `backend/src/app/composition/` (defaults), mirroring `contactRoutineModule.ts`. Domain rules stay in `backend/src/modules/approvals/` and the engine packages. ✅

**Result: PASS, no violations → Complexity Tracking empty.**

## Project Structure

### Documentation (this feature)

```text
specs/091-human-in-the-loop-approvals/
├── spec.md              # Feature spec (rev 2)
├── plan.md              # This file (Tranche A)
├── research.md          # Phase 0 — decisions/rationale (Tranche A)
├── data-model.md        # Phase 1 — entities, schema, state transitions
├── quickstart.md        # Phase 1 — how to exercise & test the approval loop
├── contracts/
│   ├── engine-contracts.md     # conversation-contract additions + resume helper
│   └── decision-endpoint.md    # the authenticated decision REST contract
└── tasks.md             # Phase 2 — /speckit.tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/
├── conversation-contract/index.d.ts        # + RoutineAwaitingDecision, DecisionOption,
│                                            #   awaitingDecision on ConversationRoutineResumeResult,
│                                            #   RoutineStep.kind += "await" + decision,
│                                            #   SuspendedRoutineReader, RoutineDecisionInput,
│                                            #   resumeAwaitingDecision on ConversationEngine,
│                                            #   MessageSource + source on message/event,
│                                            #   RoutineTraceStepEntry.event += suspended/decision_*
├── conversation-engine/src/
│   ├── awaitingDecision.ts                  # NEW — pure resume helper (mirrors clarification.ts)
│   ├── index.ts                             # DefaultConversationEngine.resumeAwaitingDecision (no synthetic user event)
│   └── routineRunner.ts                     # UNCHANGED for resume (spike-proven); `await` kind is a no-op transit for resume
└── conversation-engine/tests/
    └── spike-resume-awaiting-decision.test.ts  # seed → graduate into US1 unit tests

backend/
├── src/
│   ├── db/migrations/
│   │   ├── 102_message_source_discriminator.sql     # messages.source TEXT (unconstrained)
│   │   ├── 103_routine_states_suspended.sql         # status += 'suspended', + version int
│   │   └── 104_pending_decisions.sql                # NEW table (sibling of routine_action_requests)
│   ├── db/repositories/
│   │   ├── routineStateRepository.ts                # loadActive unchanged (status='active'); + loadSuspended(handle); version-guarded save
│   │   └── pendingDecisionRepository.ts             # NEW — create / loadByHandle / resolve(CAS) / listPending
│   ├── modules/
│   │   ├── approvals/                               # NEW focused module
│   │   │   ├── public.ts                            # PendingDecision domain types + ports
│   │   │   ├── domain.ts                            # option validity, content-hash, decider-scope rules
│   │   │   └── service.ts                           # validate → record(CAS) → invoke ResumeRunner port
│   │   ├── routines/{domain.ts,compiler.ts,validator.ts}   # `approval` author kind → runtime `await`; invariants
│   │   └── chat/services/
│   │       ├── chatService.ts                       # resumeAwaitingDecisionTurn (sibling of attemptRoutineTurn); suspend path
│   │       ├── chatTurnLifecycle.ts                 # suspended-turn outcome (non-answer)
│   │       ├── deferredRoutineStore.ts              # extend command-capture: park (don't advance) + pending-decision transition
│   │       ├── infra/postgresAssistantTurnPersistence.ts  # completeAssistantTurn += pendingDecisionTransition (one tx)
│   │       └── actions/approvalRequestActionHandler.ts    # NEW — notify (mirrors contactSendActionHandler)
│   ├── app/http/
│   │   ├── routes/decisionRoutes.ts                 # NEW — POST /api/agents/:agentId/decisions/:handle/resolve
│   │   └── openapi/document.ts                      # register decision endpoint + message `source` field
│   └── app/composition/builtIn/approvalModule.ts    # NEW — wire repo + handler + ResumeRunner binding (mirrors contactRoutineModule.ts)
└── tests/{unit,integration,contract}/               # TDD: runner resume, atomic commit, endpoint authz/idempotency, contract

frontend/
├── components/dashboard/quality-view.tsx            # "needs approval" signal/filter + per-row approve/reject
├── components/dashboard/conversation-drawer.tsx     # source rendering (read-only)
├── components/dashboard/chat-message-thread.tsx     # render message `source`
├── lib/api-approvals.ts                             # NEW adapter for queue + decision endpoint
└── tests/{unit,e2e}/                                # Playwright journey; unit on queue mapper

typescript-sdk/ + packages/radioso-mcp-server/       # regenerated types for `source` + decision endpoint
docs/ + docs-portal/content/                          # authoring (approval step), operator queue, API `source`/endpoint
```

**Structure Decision**: Web project (backend + frontend + packages). The capability-neutral **primitive lives in the engine packages** (knows only "a step awaits resolution of handle X"); the **pending-decision domain + persistence live in a new focused `backend/src/modules/approvals/` module**; **orchestration stays in `chat`** (it owns the turn lifecycle and the atomic commit); **transport** is a new `decisionRoutes.ts` + the Quality-view surface; **composition** wires the notification handler and the resume-runner binding. This keeps the engine product-agnostic, prevents `chatService.ts` from absorbing decision domain logic, and keeps the conversation-actions outbox a pure dispatch transport.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/decisionRoutes.ts` (validated decision submission; translates request → calls `approvals` service, owns no rules); `backend/src/app/http/openapi/document.ts` (contract registration). Frontend: `quality-view.tsx` (queue affordance), `lib/api-approvals.ts` (adapter). These translate and present only.
- **Orchestration Layer**: `chat/services/chatService.ts` — routes a routine turn into suspension (via the existing `attemptRoutineTurn` path when the engine returns `awaitingDecision`) and exposes a `resumeAwaitingDecisionTurn` that loads suspended state, calls `engine.resumeAwaitingDecision`, and persists via `completeAssistantTurn`. It coordinates but MUST NOT own decision validation, the pending-decision store, notification, or audit construction. `chatTurnLifecycle.ts` records the suspended-turn outcome (non-answer).
- **Domain Layer**: engine packages (`awaitingDecision.ts` + contract) own the generic suspend/resume mechanics; `routines/{domain,compiler,validator}.ts` own the `approval`→`await` authoring + the compiler invariants (deterministic decision edges, no `collectsSlots` on the gate, gate-before-side-effect); `modules/approvals/{domain,service}.ts` own decision validity (option in set, content-hash match, decider scope) and the validate→record→resume orchestration of a *decision* (distinct from a *turn*).
- **Persistence/Integration Layer**: `pendingDecisionRepository.ts` (new, CAS resolve, one-open-per-gate unique index); `routineStateRepository.ts` (`loadSuspended(handle)`, version-guarded `save`); `postgresAssistantTurnPersistence.ts` (extend the single `withTransaction` to also write the pending-decision row); `actions/approvalRequestActionHandler.ts` (notification via the existing contact-delivery resolver + worker dispatcher).
- **Application Composition**: `backend/src/app/composition/builtIn/approvalModule.ts` (NEW) registers the `approval.request` action handler (via `registerActionHandler`, mirroring `contactRoutineModule.ts`), constructs the `PendingDecisionRepository`, and binds the **ResumeRunner port** (so `approvals.service` invokes chat's resume without importing chat internals — dependency direction: approvals → narrow injected port, not chat module). Composition assembles; it owns no decision rules.
- **Files Kept Small**: `chatService.ts` (already large — add a thin `resumeAwaitingDecisionTurn` delegating to the engine + persistence; do **not** inline decision validation or store logic); `routineRunner.ts` (**unchanged for resume** — the spike proves it; only the suspend-side `await` kind detection is added, kept minimal); the conversation-actions outbox (`actionDispatcher.ts`/`actionRequestRepository.ts`) stays a pure dispatch transport — **no** decision lifecycle added.
- **Planned Extractions**: `modules/approvals/` (new module: decision domain + service); `pendingDecisionRepository.ts` (new repo); `awaitingDecision.ts` (new engine helper); `SuspendedRoutineReader` port; a `ResumeRunner` port (chat-implemented, approvals-consumed, composition-bound); `approvalRequestActionHandler.ts`; `decisionRoutes.ts`; `lib/api-approvals.ts`.
- **Required Refactor Stories**: None required to start. `chatService.ts` is already large but the addition is a thin, well-bounded delegating method; if during implementation the suspend/resume wiring threatens to bloat it, extract a `chat/services/approvalTurn/` helper (note as a contingency, not a prerequisite).

## Implementation Sequence (Tranche A slices)

Ordered so each slice is independently testable and OSS stays green. US3 (source) is cheap and unblocking; US1 is the keystone; US2 makes it operable.

1. **Slice A1 — message `source` discriminator (US3 / FR-013)**: migration `102` (`source TEXT`, unconstrained, reserved `human_agent_on_behalf_of_ai_agent` value carried in the type union only); persistence mapper stamps `source` (`user→customer`, `assistant→ai_agent`, `system`); read derives from role for old rows; contract field + OpenAPI/SDK/MCP regen; drawer/thread render source. Tests: persistence-mapper unit + migration round-trip + drawer source-badge transform unit.
2. **Slice A2 — engine primitive (US1 engine half / FR-005)**: contract additions (`await` kind, `awaitingDecision`, `RoutineDecisionInput`, `SuspendedRoutineReader`, `resumeAwaitingDecision`, trace events); `awaitingDecision.ts` helper; `DefaultConversationEngine.resumeAwaitingDecision` (no synthetic user event). Graduate the spike seed into engine unit tests (approve/reject/no-selector control). Runner stays unchanged for resume.
3. **Slice A3 — authoring (US1 / FR-001)**: `approval` author step kind in `routines/domain.ts`; compiler maps `approval→await` with the **enforced invariants** (deterministic decision edges, no `collectsSlots`, gate-before-side-effect, one edge per outcome + fallback); validator diagnostics. Tests: compiler/validator unit (real compiler).
4. **Slice A4 — durable suspend + stores (US1 / FR-002,003,004,016)**: migration `103` (suspended status + version), migration `104` (`pending_decisions`); `pendingDecisionRepository`; `routineStateRepository.loadSuspended` + version-guarded save + `loadActive` still `status='active'`; extend `deferredRoutineStore` + `postgresAssistantTurnPersistence.completeAssistantTurn` to park-and-persist the pending-decision row atomically; pause the abandon clock. Tests: integration — suspend persists atomically; `loadActive` excludes suspended; abandon sweep skips; rollback leaves no orphan.
5. **Slice A5 — decision endpoint + suspended-turn outcome (US1 / FR-006,007,008,009,015)**: `modules/approvals/{domain,service}`; `decisionRoutes.ts` (`POST /api/agents/:agentId/decisions/:handle/resolve`); validated submit (open / member / decider-scope / hash / option) → CAS resolve → `resumeAwaitingDecisionTurn` → `completeAssistantTurn`; suspended-turn non-answer outcome + `chat.suspended` audit + `hitl.decision` audit + trace events. OpenAPI/SDK/MCP regen. Tests: integration (authz 403, double-submit 409, stale-hash 409, crash-before-resume idempotent, action fires exactly once on approve / zero on reject); contract test.
6. **Slice A6 — notification (US2 / FR-010)**: `approvalRequestActionHandler` registered like `contact.send`; the suspend turn emits an `approval.request` outbox action carrying the handle link; reuse the per-agent contact-delivery resolver. Tests: integration (handler routes through the worker; re-notify reuses the row with a fresh de-duped nudge). Queue-doc + payload note.
7. **Slice A7 — operator queue (US2 / FR-011,012,014)**: Quality-view "needs approval" signal tile + filter + per-row approve/reject calling the endpoint (optimistic, revert on failure); read-for-all / act-for-deciders; no double-handling. Tests: Playwright operator approve→resume journey; queue-mapper unit. Docs: operator guide.

## Phase 0 / Phase 1 outputs

- **Phase 0** → [research.md](./research.md): all decisions resolved (no open `NEEDS CLARIFICATION` for Tranche A; OQ-2 resolved by spike). The five spec open-questions relevant to Tranche A (authored gate, operator decider, non-blocking, login-not-magic-link, suspended-turn-not-billed) are recorded as decisions.
- **Phase 1** → [data-model.md](./data-model.md) (entities + schema + state transitions), [contracts/engine-contracts.md](./contracts/engine-contracts.md) and [contracts/decision-endpoint.md](./contracts/decision-endpoint.md) (design-time notes; the runtime source of truth is the engine `.d.ts` and `backend/src/app/http/openapi/document.ts`), [quickstart.md](./quickstart.md).
- **Agent context update**: `update-agent-context.sh` was **intentionally not run** — `AGENTS.md`/`CLAUDE.md` is hand-maintained per the repo's own rule ("Do not regenerate it from Speckit plans, append recent changes…"). New technology in this plan (no new deps) does not warrant an auto-edit; the code-map will be updated by hand if ownership shifts.

## Complexity Tracking

*No constitution violations — no entries.*
