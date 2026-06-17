# Phase 0 — Research & Decisions: HITL Tranche A (Approval MVP)

All Tranche A decisions are resolved — there are **no open `NEEDS CLARIFICATION`** for this plan. The deep landscape/architecture research is in `.context/hitl-design-memo.md` (+ `hitl-research-synthesis.md`, `hitl-research-raw.json`); this file records the decisions that bind Tranche A.

## D1 — Resume mechanism: reuse the existing runner, add a thin entry point (RESOLVED by spike)

- **Decision**: Resume a suspended routine by injecting the decision as a routine variable and calling the **existing** `DefaultRoutineRunner.resume()`; do **not** build a new runner walk and do **not** modify the runner for resume. Add a thin engine method `resumeAwaitingDecision` that loads suspended state, validates the option, merges the decision variable, flips status to `active`, and calls `resume()` — appending **no** synthetic user input event (unlike `attemptRoutine`).
- **Rationale**: The spike (`.context/hitl-spike-runner-resume.md`, `packages/conversation-engine/tests/spike-resume-awaiting-decision.test.ts`, 3 tests green on the unmodified runner) proved that when the gate's outgoing edges are deterministic `field`/`slot_filled` guards and the decision is a pre-injected variable, `selectNext` branches in code (`routineRunner.ts:398-402`) and never consults the LLM selector. A control case with `llm` edges confirmed the model *is* otherwise called, so the result is causal. Resume starts traversal at `state.path.at(-1)` (the gate), so no prior step re-runs.
- **Alternatives considered**: (a) a separate decision-driven runner walk — rejected, unnecessary given the spike; held as a fallback only if the runner's resume cannot cleanly skip selection in some edge case. (b) routing the decision through a synthetic `TurnContext`/user message — rejected (red-team BLOCKER #3): it would run the selector/slot-extraction against fabricated content.
- **Enforced invariants (compiler)**: the `await` step's decision edges MUST be deterministic guards (no `llm` edge); the `await` step MUST NOT declare `metadata.collectsSlots`; the gated side-effecting step MUST sit *after* the gate.

## D2 — Pending decision is a sibling store, not a routine-state flag or an outbox column (RESOLVED)

- **Decision**: A new `pending_decisions` table (1:N per conversation, keyed by opaque `handle`), sibling to `routine_action_requests`. `routine_states` gains only a `suspended` status (to exclude it from `loadActive`) and an optimistic `version`.
- **Rationale**: `routine_states` is `session_id PRIMARY KEY` with an unconditioned upsert and no lock/version (verified `routineStateRepository.ts`) — a status flag there cannot hold concurrent decisions and races last-writer-wins. The outbox is a fire-and-forget *dispatch* machine (`handle(): void`); a *decision* knows decider scope, option set, content hash, deadline — different concern, and folding it in would collide the outbox's content-addressed idempotency key across re-asked approvals.
- **Alternatives**: status-flag-on-routine_states (rejected, red-team BLOCKER #1/#4); outbox column-hack (rejected, conflates dispatch with decision).

## D3 — Authored gate, not per-skill auto-gating (spec OQ-1 → (a))

- **Decision**: Tranche A gates via an authored `approval` routine step. No per-skill `requiresApproval`, no autonomy dial, no risk classifier, no new capability.
- **Rationale**: Proves the suspend→decide→resume loop on the simplest mechanism before touching the skill dispatcher's degrade-don't-wedge invariant or widening the capability decision. The `CapabilityDecision` stays binary (verified `capabilityPolicy.ts:44-57`).
- **Alternatives**: ship per-skill auto-gating in v1 (rejected — pulls the dispatcher change + settings projection into the riskiest slice).

## D4 — Operator decider; dashboard login, not magic-link (spec OQ-1/OQ-4)

- **Decision**: The deciding party is an authenticated workspace member; the decision endpoint is dashboard-authenticated and scope-checked server-side. No magic-link bearer token, no end-user in-chat decision affordance in Tranche A.
- **Rationale**: Keeps the riskiest authz primitive (a bearer-secret-in-email exchange) out of the first cut; reuses existing workspace-member auth + permission checks. The handle is the correlation key, not the credential.
- **Alternatives**: magic-link (deferred fast-follow); end-user in-chat consent (later phase).

## D5 — Pending decision is non-blocking for the visitor (spec OQ-3 → (a) for operator decisions)

- **Decision**: While a decision is pending out-of-band, an inbound visitor message is answered as a normal turn (`loadActive` returns null for the suspended routine), and **no new routine activates over the suspended one**.
- **Rationale**: Matches the verified `loadActive`-returns-null fall-through; the visitor should not be frozen waiting on a human elsewhere. The suspended routine resumes only via the decision.
- **Alternatives**: blocking ("waiting for a teammate") — reserved for end-user in-chat consent (later phase), not operator approvals.

## D6 — A suspended turn is a non-answer outcome (spec OQ-5 → (a))

- **Decision**: The suspend turn is recorded as a distinct `chat.suspended` outcome; it is not a completed assistant answer and is not billed as an answered turn. The resumed turn (which produces the answer) is the answered/billed turn.
- **Rationale**: A pause produced no answer ("you pay for answers, not for waiting"). Requires the suspended-turn path to release/record the usage reservation under a `suspended` disposition rather than `commit()`-ing it as an answer.
- **Open follow-up**: confirm against the usage-metering model during implementation of Slice A5 (does releasing vs. recording-as-suspended fit the meter cleanly?). Non-blocking for the architecture.

## D7 — Notification reuses the outbox as transport only (RESOLVED)

- **Decision**: A new outbox action **type** `approval.request` with a handler registered exactly like `contact.send`, delivering through the existing per-agent contact-delivery resolver, carrying the single-use handle link. The outbox stays fire-and-forget; the decision lives in `pending_decisions`.
- **Rationale**: The contact feature already proves this spine (`contactRoutineModule.ts` + `registerActionHandler` + worker dispatcher). Reuse, don't reinvent. Message-queue review: new action type only; retry/lease semantics unchanged; no AMQP/dispatch payload change.
- **Alternatives**: a dedicated notification service (rejected — unnecessary; the outbox is the transport).

## D8 — Source stored as unconstrained `TEXT`, full vocabulary carried (spec fix 1)

- **Decision**: `messages.source` is an unconstrained `TEXT` column; the type union carries `customer | ai_agent | human_agent | human_agent_on_behalf_of_ai_agent | system`, with the last value **reserved/unused** in Tranche A.
- **Rationale**: Adding the reserved value when the silent-reply phase lands needs neither a migration nor a contract change — the retrofit insurance US3 buys. The engine never branches on `source`.
- **Alternatives**: a DB enum/CHECK (rejected — would force a migration to add the reserved value later).

## D9 — Operator queue: extend Quality view, poll-based (RESOLVED)

- **Decision**: The approval queue is a new "needs approval" signal/filter inside the existing Quality view (which already renders `paused`/`awaiting_confirmation`/`awaiting_tool` badges + an `open→acknowledged→resolved→dismissed` triage machine), refreshed by polling (20–30s). No websockets/SSE in Tranche A.
- **Rationale**: Reuses the operator triage surface and its patterns; approvals are minutes-scale, so polling is adequate. A dedicated Inbox section is revisited only if volume data demands it.
- **Alternatives**: a new top-level Inbox section (deferred); realtime push (Tranche B concern, and only genuinely needed for takeover).
