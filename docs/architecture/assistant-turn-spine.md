# Assistant Turn Spine

The assistant turn is a loop that gathers context, dispatches capabilities, and
composes a reply. Capabilities are **skills**. Retrieval is one skill among them,
not a privileged step.

## The shape of a turn

A turn moves through four phases:

1. **Gather** — interpret the user's message (intent, query rewrite, routing).
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

The engine's turn trace (its gather/directive/selection/dispatch/compose stages)
is recorded on the `chat.answer` success audit event under
`metadata.conversationEngine.trace`, alongside the retrieval-derived
`activityTrace`. This is audit-only observability; the user-facing answer and
activity trace are unchanged.

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

## Routines run before selection

Before normal skill selection, the turn checks for a **routine** — a stateful flow
that runs across several turns. If a routine is active for the session it resumes
at its saved step; otherwise the turn checks whether any of the agent's published
routines should activate, and the highest-priority matching trigger wins.

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
