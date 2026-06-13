# Implementation Plan: Clarification Capability

**Branch**: `085-clarification-capability` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/085-clarification-capability/spec.md`

## Summary

When matching produces two or more comparable candidates, ask the user instead of
guessing, map the free-text reply, and resume. One generic Clarifier (contract +
pure decide in the engine layer, LLM phrase/map implementations in
conversation-defaults) consumed by two surface-owned detectors: a new ranked
multi-routine activation matcher (replacing the first-match short-circuit; one
model call for all routines) and a retrieval sense detector (document-grouping of
top results with embedding-separation cohesion check). Pending state persists in a
new `clarification_states` table committed atomically with the assistant turn via
the existing deferred command-capture + transaction-port discipline. Every
decision lands as a new `clarification` spine trace stage rendered first-class in
the dashboard turn-flow debug view.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend, packages), TypeScript 5.7 / React 19 / Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, conversation-contract/engine/defaults workspace packages, OpenAI SDK adapters (GPT-5.2 default)
**Storage**: PostgreSQL 16 + pgvector — new `clarification_states` table; chunk embeddings read for sense-separation check
**Testing**: Vitest (packages + backend unit/integration), Playwright (frontend journeys), frontend Vitest for non-visual transforms
**Target Platform**: Linux server (Docker Compose dev), browser dashboard
**Project Type**: web (backend + frontend + workspace packages)
**Performance Goals**: zero added model calls on unambiguous turns; routine activation = exactly one model call regardless of routine count (SC-004); sense detection structural precondition is pure arithmetic
**Constraints**: no behavior change on clear-winner/unambiguous paths (SC-003); no English keyword lists; conversational copy LLM-only; trace content metadata-safe
**Scale/Scope**: 2 detectors + 1 shared capability; ~6 modules touched across contract/engine/defaults/backend/frontend; 1 migration

## Constitution Check

- Spec exists and is approved (rev 2 + SC-004 wording fix, user-approved) — gate passed.
- Backend TDD: every backend slice below starts with failing Vitest tests (unit for pure decide/matcher/grouping, integration for lifecycle commit) — encoded in tasks.
- Frontend: turn-flow graph + stage-detail transforms covered by frontend unit tests (non-visual data transforms); operator journey covered by Playwright on the trace view; no markup/cosmetic assertions.
- Stack: Node.js backend, React frontend, PostgreSQL + pgvector (embedding separation check uses stored vectors), GPT-5.2 via existing model gateways — unchanged.
- Secrets: none added; no `.env`/`.env.example` change (policies are typed composition constants — research R9).
- Customer data: pending-state rows store candidate labels/ids, document ids, and
  the originating visitor message while a clarification is pending. The message is
  nulled when the row becomes resolved, declined, or expired; no chunk content is
  stored. Trace stages exclude payloads and the stored original message; counters
  are two-label low-cardinality (research R8).
- Module boundaries: explicit below; chat orchestration stays orchestration-only; Clarifier knows no surface vocabulary; detectors own payload + continuation.
- Responsibility-limited files identified: `chatService.ts` (orchestration-only), `queryRewriteService.ts` (untouched), `routineRegistry.ts` (registry + matcher seam only), `chatTurnLifecycle.ts` (gains one deferred-transition input, no domain logic).
- Composition: new wiring (clarifier instances, policies, prompt templates, store, matcher) is assembled in `backend/src/app/server/dependencyBuilders.ts` / `backend/src/app/composition/` per constitution VI — domain rules stay in modules/packages.
- OpenAPI: **no HTTP contract change** — trace stage `kind` is an open string in `assistantHistorySchemas.ts`; no new endpoints. No regeneration needed; contract tests unaffected (verified in research R7).
- Message-queue impact review: **no impact** — no worker payloads, AMQP queues, document-worker dispatch, or retry semantics change. Pending clarification is request-path conversation state inside the existing assistant-turn transaction. (Re-affirmed post-design.)
- Docs parity: `docs/architecture/assistant-turn-spine.md` (clarification stage + ordering), `docs/architecture/conversational-routines.md` (ranked activation replaces first-match), docs-portal operator/guide entry for clarification behavior + debug view. Read `docs/document-writer-prompt.md` first (tasked).
- Prompt assets: 4 new templates under `backend/prompts/chat/` (ranked activation, clarification question, reply mapping, sense labels) — constitution X.
- Contract change note: `ConversationRoutineActivator.activate` union change is an internal/private-kit contract; version-noted in the d.ts header (no published-package consumers yet — standalone kit D5 publish still pending).

## Project Structure

### Documentation (this feature)

```text
specs/085-clarification-capability/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R10
├── data-model.md        # Phase 1 — contract types, table, transitions
├── quickstart.md        # Phase 1 — how to exercise and validate
├── checklists/requirements.md
└── tasks.md             # Phase 2 (/speckit.tasks)
```

### Source Code (repository root)

```text
packages/conversation-contract/
└── index.d.ts                          # +Clarification types/ports; activator outcome union

packages/conversation-engine/
├── src/clarification.ts                # NEW: pure decide(), deterministic ordering, trace stage builder
├── src/index.ts                        # attemptRoutine handles activator "clarify" outcome (ask path)
└── tests/clarification.test.ts         # NEW: pure-logic unit tests

packages/conversation-defaults/
├── src/clarifier.ts                    # NEW: LLM phraseQuestion/mapReply (gateway + injected templates)
├── src/routineRegistry.ts              # RoutineRegistration → declarative trigger metadata; ranked matcher
└── tests/                              # matcher + clarifier tests

backend/
├── prompts/chat/
│   ├── routine-ranked-activation.md    # NEW: one-call ranked trigger matching
│   ├── clarification-question.md       # NEW
│   ├── clarification-reply-map.md      # NEW
│   └── clarification-sense-labels.md   # NEW
├── src/db/migrations/0XX_clarification_states.sql   # NEW (next sequential number)
├── src/db/repositories/clarificationStateRepository.ts  # NEW
├── src/modules/chat/services/
│   ├── chatService.ts                  # +resolve-pending step before routine attempt (orchestration only)
│   ├── chatTurnLifecycle.ts            # +clarification transition in transaction port + fallback
│   ├── conversationProcessTurnInput.ts # thread clarification ports into routine attempt input
│   └── clarification/
│       ├── deferredClarificationStore.ts   # NEW: command-capture wrapper
│       └── pendingClarificationResolver.ts # NEW: host-side resolve-pending orchestrator helper
├── src/modules/retrieval/
│   ├── public.ts                       # +documentScope on RetrievalPipelineRequest
│   └── services/
│       ├── senseGroupingService.ts     # NEW: document-grouping + embedding-separation detector
│       └── candidatePreparationStage.ts # apply documentScope post-retrieval filter
├── src/app/server/dependencyBuilders.ts # wire clarifier, policies, store, matcher, prompts
└── tests/unit|integration/             # TDD per slice (see tasks)

frontend/
├── lib/turn-trace.ts                   # +clarification stage label
├── lib/turn-flow.ts                    # +clarification node in flow graph
├── components/dashboard/spine-stage-detail.tsx  # +ClarificationStageDetail renderer
└── tests/unit/turn-flow.test.ts / turn-trace.test.ts  # extended
```

**Structure Decision**: web application (existing backend + frontend +
workspace packages). Contract/engine/defaults packages own the generic
capability; backend modules own the two detectors and persistence; composition
assembles; frontend renders the trace stage.

## Module Ownership & Seams

- **Transport Layer**: none changed — no new routes; trace flows through the
  existing history/chat endpoints whose stage schema is already open.
- **Orchestration Layer**: `chatService.ts` adds exactly one step
  (resolve-pending before routine attempt) delegating to
  `pendingClarificationResolver`; `chatTurnLifecycle.ts` carries one more
  captured transition into the existing transaction port. Neither contains
  scoring, phrasing, mapping, or thresholds.
- **Domain Layer**:
  - Generic: `conversation-engine/src/clarification.ts` (pure decide +
    ordering + stage builder), `conversation-defaults/src/clarifier.ts`
    (LLM phrase/map).
  - Routine surface: ranked matcher in `conversation-defaults/src/routineRegistry.ts`
    (+ activation prompt); forced-activation wrapper host-side.
  - Retrieval surface: `senseGroupingService.ts` + `documentScope` filter in the
    retrieval module.
- **Persistence/Integration Layer**: `clarificationStateRepository.ts`
  (implements the contract store), migration, and the transaction-port
  extension in `PostgresAssistantTurnPersistence`.
- **Application Composition**: `dependencyBuilders.ts` wires clarifier
  implementations, per-surface policies (typed constants), prompt templates,
  store + deferred wrapper, ranked matcher; domain rules stay out of wiring.
- **Files Kept Small**: `chatService.ts`, `chatTurnLifecycle.ts`,
  `queryRewriteService.ts` (untouched), `turn-flow.ts` (graph transform only).
- **Planned Extractions**: `pendingClarificationResolver.ts` and
  `deferredClarificationStore.ts` exist precisely so chatService/lifecycle stay
  thin; sense detection is a named service, not a pipeline-stage inline branch.
- **Required Refactor Stories**: none — verified seams (routine attempt port,
  deferred-commit pattern, transaction port, open trace schema) are all in
  place; the activator contract change is the one deliberate breaking change
  and is contained to registry + engine + contact-routine registration.

## Complexity Tracking

No constitution violations to justify. One deliberate contract change
(`ConversationRoutineActivator` outcome union) is covered under Constitution
Check with rationale; no simpler alternative achieves SC-004.
