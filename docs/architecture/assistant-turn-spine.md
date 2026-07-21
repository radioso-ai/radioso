---
title: "Assistant Turn Spine"
description: "Core structure of the assistant conversation loop covering phases of gathering, selecting, dispatching skills, composing replies, and routing."
last_updated: 2026-07-22
---

# Assistant Turn Spine

The assistant turn is a loop that gathers context, dispatches capabilities, and
composes a reply. Capabilities are **skills**. Retrieval is one skill among them,
not a privileged step.

## The shape of a turn

A turn moves through four phases:

1. **Gather** — prepare the chat session and run turn routing after routines decline.
2. **Select** — decide which skill(s) the turn needs.
3. **Dispatch** — run the selected skill through the skill-invocation port.
4. **Compose** — build the reply from what the skills returned.

The key point: the loop holds the mechanism, skills hold the behavior. Adding a
capability means registering a skill, not editing the loop.

## Reusable contract boundary

The product-independent turn vocabulary lives in
`packages/conversation-contract/`. It defines the reusable shapes for agents,
input events, directives, steering, skills, staged context, selection decisions,
turn outcomes, traces, renderer outputs, and the `ConversationEngine` port.

The pure runtime loop lives in `packages/conversation-engine/`. Its default
engine loads history, matches directives, selects skills, dispatches selected
skills, merges directive and skill steering, composes the response, appends
events, and returns a trace. It works only through contract ports.

Radioso backend adapts its product records into those contracts. Workspace
auth, billing, document retrieval, dashboard settings, persistence, HTTP, and
streaming stay in Radioso-owned adapters. The contract package must not import
backend modules, retrieval internals, frontend code, or other product
implementation packages. The engine package follows the same rule, except it may
depend on `@radioso/conversation-contract`.

The current chat adapter entry points are
`backend/src/modules/chat/services/conversationContractMappers.ts` and
`backend/src/modules/chat/services/conversationProcessTurnInput.ts`. They project
a prepared chat session into reusable contract values without moving persistence,
billing, or rendering into the pure engine.

Backend application composition wires the reusable engine into chat in every
environment (`createConversationEngine()` in `dependencyBuilders.ts`). The engine
drives both the non-streaming turn (`processTurn`) and the streamed turn
(`processTurnStream`): its selector consults the existing `TurnSelectionStrategy`
and its dispatcher builds the `retrieval.answer` outcome from the prepared
session, instead of receiving an already-built outcome from `ChatService`. The
composer still renders through the Radioso `TurnOutcomeRendererRegistry`, and
`ChatService` continues to own session prep, the skill-intake path, lifecycle,
persistence, audit, and billing. The engine is `ChatService`'s only turn path — it
is a required dependency, with no engine-less fallback.

For streamed turns, the engine reports semantic progress immediately before
interpretation, retrieval, selection, dispatch, and compose work. The backend
adapter pumps the engine concurrently and maps those phases to the three public
chat stages. A small ordered queue is required here because a progress callback
cannot make an outer async iterator yield while the engine is awaiting work. The
pure engine knows nothing about SSE or display copy.

The renderer registry is also the incremental-delivery boundary. A renderer may
stream validated provider deltas; otherwise the registry renders once and replays
the committed presentation in bounded Unicode-safe chunks. This keeps citation,
guard, and durability policy with the renderer that understands it.

Retrieval holds candidate body text until a complete, in-range sourced assertion
appears. The private prefix is capped at 4,096 Unicode code points. Reaching the
cap aborts that provider request, discards the prefix, and returns the focused
grounded decline for committed replay. There is no time limit: a slow valid
candidate is not rejected because of provider pacing. The compose trace records
only the numeric gate wait duration, never the candidate text.

Turn routing is a chat-owned step above retrieval. `TurnRouter` classifies the
latest user turn as `retrieval` or `direct` from the raw query, recent history,
assistant identity, and configured answer scope. Retrieval query rewrite runs only
after a turn has been routed to retrieval; it no longer returns response intent or
direct-answer framing.

Response language is detected once per turn from the latest user message and
recent history. Chat starts that detector as soon as the user message is
persisted, then uses the result for routine replies, direct replies, and grounded
chat replies. Retrieval pipelines only consume a language label when chat passes
one on the request; standalone retrieval, MCP, and eval retrieval surfaces do not
run response-language detection. Query rewrite does not own response-language
selection.

## Fused turn planning

The four fresh-turn classification calls — routine activation ranking, turn
interpretation (route + rewrite), response-language detection, and contextual
directive matching — can be fused into one chat-tier `turn_planning` call. The
engine and its ports do not change. `TurnPlanService`
(`backend/src/modules/chat/services/turnPlanService.ts`) owns the prompt
(`backend/prompts/chat/turn-planning.md`), strict parsing, and semantic
validation; `turnPlanCoordinator.ts` owns the eligibility bounds and the lazy,
memoized per-turn handle that rides on the prepared session. Each existing port
adapter consumes the shared plan instead of making its own call: the routine
activator applies the plan's rankings through `RoutineRegistry`'s prepare/apply
seams (including any activation variables extracted from the turn), the
interpreter takes route and rewrite framing using the same effective workspace/
agent rewrite instructions as staged interpretation, chat takes the response
language, and the directive matcher resolves precomputed classifications through
the same route-scoped runtime. Policy stays with the owning modules; the planner
only sees candidate summaries.

The key point is that fallback is the existing staged path, all-or-nothing per
turn. A turn bypasses planning entirely (no planner call) when the env gate is
off (`CHAT_TURN_PLANNING_ENABLED`, plus the optional
`CHAT_TURN_PLANNING_WORKSPACES` allowlist), when a routine is active or parked,
when a pending clarification or decision resolves this turn, when a routine
explicitly claims the turn (including completed-routine correction or semantic
reentry), or when candidate counts or the estimated prompt
exceed the `turnPlanning` bounds in `behaviorConfig.ts`. A planner timeout,
malformed output, or an unknown routine or directive id fails the whole plan,
and every consumer falls back to its staged call — planner failure never drops a
routine or directive behavior, and planner routing is never mixed with staged
directive results.

In practice a successful direct turn makes exactly two model calls (plan +
answer); a retrieval turn makes the plan, retrieval-internal calls, and the
grounded answer. The planner call appears in the turn's model-call trace as
`turn_planning` with `pre_engine` attribution and records a usage event under
the same operation. Classification stages carry `source: "planned"` or
`source: "staged"` while the trace's stage shape stays unchanged; a rejected
planner attempt followed by fallback is reported as staged. The coordinator
also records a low-cardinality outcome counter and planner-latency histogram. The
workbench replay runner receives the same coordinator and gate through composition
and consumes the plan's route, rewrite, language, routine rankings, and directive
classifications.

The engine's turn trace (its gather/directive/selection/clarification/dispatch/
compose stages) is the root of the versioned `metadata.turnTrace` envelope on
the `chat.answer` success audit event. Capability traces, including retrieval,
hang from their dispatch stage as typed leaves. The legacy retrieval-derived
`activityTrace` remains available during the history migration.

Real spine stages record wall-clock start and completion times. The envelope's
capability leaves remain operator-facing diagnostics. In particular, the
retrieval activity trace can include queries, answer previews, and tool outputs;
the persisted envelope as a whole is therefore not content-free.

The new turn-level model-call collection and performance rollup are content-free.
They contain only structural operation and stage labels, model names, token
counts, timestamps, and durations. They do not contain attempt keys, prompts,
completions, tool arguments or outputs, retrieved chunks, document content,
credentials, or provider request IDs. Each retained call has a stable ID and is
referenced from its enclosing spine stage. Calls made before the engine starts
use the `pre_engine` attribution. The collection retains at most 64 call records;
the rollup still counts all calls and reports how many records were dropped.
Suggestion enrichment runs after the answer pipeline and is deliberately outside
the turn rollup. This boundary is the same for streamed and non-streamed turns, so
the summary measures answer production rather than optional action-chip generation.

Each envelope also carries a turn summary with total LLM calls, serial LLM
depth, the longest stage, total model time, and total turn time. Concurrent
model calls contribute to total model time but count once at that point in the
serial-depth calculation. Synthesized legacy envelopes do not receive this
summary because they did not capture the required call data. The workbench and
activity turn inspector show the summary and the per-stage timing and usage
fields for current envelopes.

## Skills are dispatched, not called

A skill is reached through one port, `SkillExecutorPort.dispatch`. A dispatch
returns a **disposition**: `settled` (the outcome is ready now) or `deferred`
(the outcome will arrive later as a session event). The outcome is a control
envelope — status, optional answer and outputs, control bits, and model-invisible
metadata — not a bare string.

A skill executor is registered at composition under the adapter name its catalog
entry declares. The loop resolves the executor from the registry and dispatches;
it never imports a concrete skill.

## Retrieval is a skill

Grounded answering uses the `retrieval.answer` skill. The chat turn reaches it
through the same port as any other skill:

- The executor (`RetrievalAnswerSkillExecutor`) wraps the retrieval controller.
- The chat turn produces grounded-answer context by dispatching `retrieval.answer`
  through the registry, then composes the reply from the result.

In practice, the chat module no longer depends on the retrieval pipeline service.
It depends on a narrow turn port (`RetrievalTurnPort`) for interpretation and
dispatch, and on the retrieval *result type* for composition. The headless
`retrieval.*` API, SDK, and MCP surfaces are unchanged — they call retrieval
directly, as before.

## Clarification resolves before routines

Clarification is a turn-level capability for cases where matching produced
several comparable candidates and the assistant should not guess. It is not a
routine, a retrieval rule, or a hard-coded keyword list.

At the start of a turn, before routine activation is attempted, chat checks
whether the conversation has a pending clarification. The reply is mapped to one
of three outcomes:

- a chosen candidate
- "none of these"
- an unrelated message

If the user chooses a routine-activation candidate, the stored candidate payload
is converted back into a forced routine activation. The routine starts as if it
had been activated directly, including activation variables captured from the
original ambiguous turn.

If the user chooses a retrieval-sense candidate, the stored payload becomes a
`documentScope` for the resolving turn. Retrieval uses the original question
from the turn that asked for clarification, scoped to the chosen document group.
The short reply that chose an option is only used for mapping the choice.

Retrieval-sense offers are lenient. If the visitor chooses an offered
alternative, retrieval answers the original question scoped to that alternative.
If the visitor ignores the offer, the pending offer is cleared silently and the
latest message proceeds as a normal turn. Blocking `ask` clarifications keep the
stricter rule: a turn that resolves one does not create a new clarification in
the same turn. The same candidate set is not asked or offered twice in a row. The
stored original question is nulled whenever the pending row becomes resolved,
declined, or expired.

## Routines run before selection

After pending clarification is resolved and before normal skill selection, the
turn checks for a **routine** — a stateful flow that runs across several turns. If
a routine is active for the session it resumes at its saved step; otherwise the
turn checks whether any of the agent's published routines should activate.

A routine does not add a new steering channel. Its current step is projected into a
directive, so it steers the reply through the same matched-directive set as any
standing rule. The routine advances along the first transition guard that holds;
most guards (`always`, `slot_filled`, `outcome`, `counter`, `fallback`) are
resolved without a model call, so the flow is predictable. Slots are filled from
the user's message, and one message that supplies several values can advance
through several steps in a single turn.

Routines are authored as data, not registered in code. The chat adapter loads the
turn agent's published routines, compiles each into the engine's `Routine` graph,
and runs them through the engine's routine runner. The authoring data model,
compiler, and validator live in `backend/src/modules/routines/`; the runtime lives
in `packages/conversation-engine/`. See
[Conversational routines](./conversational-routines.md).

Only `published` routine versions are activation candidates. If a session already
has routine state, composition also loads that pinned version for resume, even
when it has since become `superseded` or `archived`.

## Clarification appears on the spine

The turn trace records clarification as a first-class `clarification` stage. The
stage can appear in three shapes:

- **Claimed ask turn** — routine activation or retrieval sense detection decides
  the candidates are too close to choose silently. The assistant asks one
  clarifying question, the pending clarification is saved with the turn, and no
  candidate executes on that turn.
- **Answer-with-offer turn** — retrieval sense detection soft-picks the strongest
  candidate, saves the remaining close candidates as an offer, answers from the
  winner's document scope, and records `decision: "offered"`.
- **Pass-through turn** — the system silently picks a candidate because there is
  a clear winner, a unique authored priority winner, loop-guard suppression, or
  active-routine suppression. Labeling failure also auto-picks the top
  retrieval-sense candidate and records `reason: "label_fallback"`. The trace
  records the candidate set and reason, then the turn continues to routine
  activation or retrieval dispatch.

Clarification asks are suppressed while routine state is active, including turns
where the routine yields as off-topic to normal answering. Detectors may still
run, but the Clarifier auto-picks the top candidate and records the decision as
suppressed. This keeps active routine state and pending clarification state from
competing to interpret the visitor's next message.

The retrieval-sense detector runs only on conversational retrieval turns, after
retrieval has produced candidates and before the grounded answer is composed.
The default retrieval-sense policy is answer-first: `askMargin = 0.03`, so a
no-clear-winner set that survives floor, loop guard, and priority checks becomes
an offer instead of a blocking question — except when the top two senses are
within the `0.03` tie band, where they are statistically indistinguishable and a
blocking ask is still used. Routine activation keeps `askMargin = clearMargin`,
preserving the blocking ask behavior for routine ambiguity.
Standalone retrieval answer, document search, SDK retrieval, and MCP retrieval
surfaces do not ask clarifying questions.

## Adding a skill

To make a new capability available to the assistant:

1. Add a catalog entry that declares the skill's intent, inputs, outcomes, and
   execution adapter.
2. Register an executor for that adapter at composition.

Nothing in the turn loop changes. The loop already knows how to gather, select,
dispatch, and compose; a new skill is new behavior plugged into that mechanism.

## What is not built yet

The port models `deferred` results so a skill can return later, but no shipped
skill defers today and there is no engine that resolves a deferred result. The
per-turn skill selection is a single default strategy. These are deliberate
limits, not gaps to work around.
