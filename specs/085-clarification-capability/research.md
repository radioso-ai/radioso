# Research: Clarification Capability (085)

All unknowns from Technical Context resolved. Code references verified on branch
`085-clarification-capability` (base: post-082 main).

## R1. Where the Clarifier lives

- **Decision**: Types and ports in `packages/conversation-contract/index.d.ts`
  (hand-maintained d.ts). Pure decision logic (closeness policy evaluation,
  deterministic ordering) plus trace-stage builders in
  `packages/conversation-engine` (new `src/clarification.ts`). LLM-backed
  implementations (question phrasing, reply mapping) in
  `packages/conversation-defaults` (new `src/clarifier.ts`), taking
  `ConversationModelGateway` + injected prompt template strings — the exact
  pattern `RoutineNextStepSelector` / `RoutineStepRenderer` already use
  (`packages/conversation-defaults/src/routineNextStepSelector.ts`, wired with
  `loadPromptTemplate(...)` in `backend/src/app/server/dependencyBuilders.ts:879-887`).
- **Rationale**: contract stays dependency-free; the engine package stays pure
  (no model calls — ports only); defaults package already holds composable
  LLM-backed implementations; prompts stay under `backend/prompts/` per
  constitution X.
- **Alternatives considered**: Clarifier wholly in backend modules — rejected:
  the spec requires it in the conversation engine layer so the standalone kit
  keeps parity and future detectors (step-input) can consume it.

## R2. Turn orchestration: where ask/resume happen

- **Decision**: Host orchestration (`ChatService.answerWithinTrace` /
  `streamAnswerWithinTrace`, `backend/src/modules/chat/services/chatService.ts:390-676`)
  gains one step **before** `attemptRoutineTurn`: load pending clarification and
  resolve it (LLM reply-map). Resolution outcomes:
  - chosen + source `routine_activation` → clear pending (deferred) and run the
    routine attempt with a **forced activation** (host wraps the activator to
    return the chosen routine + stored variables deterministically — no model
    call);
  - chosen + source `retrieval_sense` → clear pending (deferred) and constrain
    the retrieval request with the payload's document scope, then proceed
    normally;
  - none / unrelated → clear pending (deferred), proceed normally.
  Asks are produced where the candidates arise: the routine-activation ask
  inside the routine-attempt path (activator returns a `clarify` outcome; the
  question turn claims the turn like a routine reply does), the retrieval-sense
  ask inside the retrieval.answer skill execution (outcome becomes a question
  instead of a grounded answer).
- **Rationale**: retrieval runs host-side around the engine (session prep →
  routine attempt → interpret → dispatch → compose), so a resolved sense
  constraint must be applied before retrieval executes — only the host can do
  that. Forced activation through the existing activator port keeps the engine's
  routine path unchanged for resume.
- **Alternatives considered**: engine-owned resume (engine resolves pending and
  returns a "constraint" for the host to apply) — rejected: leaks retrieval
  vocabulary into the engine result contract and inverts the prep-owns-retrieval
  parity rule.

## R3. Ranked activation matcher and the activator contract

- **Decision**: Evolve `RoutineRegistration`
  (`packages/conversation-defaults/src/routineRegistry.ts:16-22`) from a
  per-routine `activates()` callback to declarative trigger metadata
  `{ triggerDescription, priority }`; the registry's activator becomes a
  **single ranked matcher**: one model call over all eligible routines returning
  per-routine `{ routineId, confidence, variables? }`, then the pure decision
  order from the spec (floor → margin → unique-priority arbitration → clarify).
  `ConversationRoutineActivator.activate` (contract) returns a union:
  `{ kind: "activate", routineId, variables? } | { kind: "clarify", candidates } | null`.
  The built-in contact routine's `contactActivationClassifier` is replaced by a
  trigger description entering the same ranked call.
- **Rationale**: SC-004 (one model call) is unachievable with per-registration
  callbacks; published routines already carry `activation.triggerDescription` +
  `priority` (`backend/src/modules/routines/domain.ts:77-81`); gate filtering
  already happens before registration reaches the registry (gateRef note), and
  the capability gate check stays where it is today.
- **Alternatives considered**: keep `activates()` and add a parallel ranked
  path — rejected: two activation mechanisms, SC-004 violated when legacy
  registrations exist. Backward-compat union accepted instead: this contract is
  internal to the repo + private kit (version-noted in the d.ts).
- **Risk noted for tasks**: contact-activation quality must be re-verified under
  the ranked prompt (existing contact activation tests updated, not deleted).

## R4. Pending state persistence and atomic commit

- **Decision**: New table `clarification_states` mirroring `routine_states`
  (`backend/src/db/migrations/071_routine_states.sql`): `session_id` PK,
  `source`, `candidates` JSONB (with opaque payloads), `status`
  (`pending|resolved|declined|expired`), `asked_event_id`, `expires_at`,
  timestamps. Repository implements the new `ConversationClarificationStore`
  contract (loadPending/save/clear). A `DeferredClarificationStore`
  command-capture wrapper (same shape as `DeferredRoutineStore`,
  `backend/src/modules/chat/services/routines/deferredRoutineStore.ts`) defers
  save/clear; the captured transition is added to the
  `AssistantTurnPersistence.completeAssistantTurn` transaction port input
  (`backend/src/modules/chat/services/chatTurnLifecycle.ts:423-447`) and the
  fallback path, so ask/resolve commit atomically with the assistant message.
  TTL default mirrors routine state (30 min).
- **Loop guard**: keep the last non-pending row (status `declined`/`resolved`)
  until TTL; the decide step suppresses an ask whose source + candidate-id set
  matches a recently declined/unmapped row.
- **Alternatives considered**: reuse `routine_states` with a new status —
  rejected: collides with the single-active-routine invariant and couples two
  lifecycles the spec keeps distinct.

## R5. Sense grouping without in-memory embeddings

- **Decision** (v1, satisfies spec contract): after candidate retrieval, group
  the top results by `documentId` (each `RetrievedChunk` carries `documentId`,
  `title`, `similarity`, `metadata` —
  `backend/src/modules/retrieval/domain/vectorSearch.ts:3-14`). A split
  qualifies structurally when ≥2 document-groups each hold a material share of
  the top-K (default ≥30%). For qualifying splits only, run the cohesion check:
  fetch the involved chunks' embeddings via a pgvector query (embeddings are in
  the DB, not in memory) and require inter-group centroid distance above a
  separation threshold. Only when a split qualifies, one LLM call labels the
  groups from document titles/metadata (multilingual; never raw chunk text).
- **Rationale**: zero added latency on the common (unambiguous) path — the
  structural precondition is pure arithmetic on the already-retrieved set; the
  embedding check and labeling call run only on rare qualifying splits.
- **Alternatives considered**: LLM-based grouping of every result set —
  rejected (adds a model call to every retrieval turn; chat-latency lesson);
  title/keyword similarity — rejected (English-centric heuristics violate the
  multilingual rule).

## R6. Constraining the resolving turn to the chosen sense

- **Decision**: the candidate payload stores the group's `documentId`s. On the
  resolving turn the host sets a new optional `documentScope: string[]` on
  `RetrievalPipelineRequest`; it is applied as a **post-retrieval filter** at
  candidate preparation (before rerank/selection), in the retrieval module.
  Pre-search filtering at the vector/lexical ports is a noted future
  optimization, not v1 (today's ports expose `sourceFilter`/`metadataFilter`
  but no document-id parameter —
  `backend/src/modules/retrieval/services/candidateRetrievalStage.ts:52-81`).
- **Rationale**: smallest correct change; the resolving turn re-queries normally
  and the filter guarantees grounding only in the chosen group (SC-002's
  citation check), without touching search-port contracts.

## R7. Trace stage and frontend rendering

- **Decision**: new spine stage kind `clarification` (engine-owned builder),
  outputs: surface, decision (`auto_picked|asked|suppressed`), reason
  (`clear_margin|priority|suppressed_routine_active|loop_guard`), candidates
  (id, label, confidence), closeness margin, and — on resolving turns —
  mapping outcome (`mapped:<id>|declined|unrelated`). No OpenAPI change needed:
  `ConversationTraceStageSchema.kind` is open `z.string()`
  (`backend/src/app/http/openapi/schemas/assistantHistorySchemas.ts:112-125`).
  Frontend: label map in `frontend/lib/turn-trace.ts:17-29`, first-class node in
  `frontend/lib/turn-flow.ts` (today it only renders known kinds), dedicated
  renderer in `frontend/components/dashboard/spine-stage-detail.tsx` keyed on
  `kind === "clarification"`. Unit tests follow
  `frontend/tests/unit/turn-flow.test.ts` patterns.
- **Trace envelope**: additive — `TURN_TRACE_ENVELOPE_VERSION` stays 1.

## R8. Counters

- **Decision**: `metricsRegistry.incrementCounter("clarification_decisions_total",
  { labels: { surface, decision } })`
  (`backend/src/shared/observability/metrics/metricsRegistry.ts`) — two
  low-cardinality labels; decisions: asked, auto_picked, suppressed, mapped,
  declined, expired. No analytics events in v1 (FR-012 needs counts only); no
  content-bearing fields.

## R9. Closeness policy defaults

- **Decision**: typed constants per surface in composition wiring (not env, not
  DB): routine activation `{ floor: 0.4, margin: 0.15, maxOptions: 4 }`;
  retrieval sense `{ minGroupShare: 0.3, separationThreshold: <tuned>, maxOptions: 4 }`.
  Values are starting points to be tuned against the test fixtures during
  implementation; the structure (per-surface typed policy objects passed to the
  pure decide function) is the binding part. No `.env`/`.env.example` change.

## R10. Speckit agent-context script

- **Decision**: skip `.specify/scripts/bash/update-agent-context.sh` — AGENTS.md
  maintenance rules forbid generated technology inventories, and this feature
  introduces no new technology (same stack, packages, and test runners).
