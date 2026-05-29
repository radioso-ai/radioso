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
