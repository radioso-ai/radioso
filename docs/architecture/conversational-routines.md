# Conversational Routines

A Routine is a multi-step flow the assistant can run across several turns. It
collects the information a task needs, takes an action, and confirms — keeping
its place and its captured values between turns.

An example: a "contact a human" routine asks for an email, asks for a message,
submits the request, then confirms it was sent.

Unlike a Skill or a Directive, a Routine is **authored as data**. An operator
builds it in the agent's **Routines** settings, and the platform compiles it into
a graph the conversation engine runs. No code or redeploy is needed to add one.

## Routines, skills, and directives

Radioso has three kinds of unit the assistant works with on a turn.

- A **skill** is something the assistant *does* on a single turn — grounded
  retrieval, a lookup. It is dispatched and returns a result.
- A **directive** is a standing rule that shapes *how* the assistant behaves on a
  turn. It is matched and added to the prompt.
- A **routine** is a *stateful flow* that carries a task across turns. While a
  routine is active it steers each turn by projecting its current step into a
  directive, so it reuses the same steering path rather than a separate one.

The key point: skills act, directives steer, routines carry a flow across turns.

## What a routine is made of

A routine definition has four parts.

- **Slots** — the typed values the routine needs to collect, such as an email or
  an order number. Each slot has a name, a type, and whether it is required.
- **Steps** — the units of the flow. A `chat` step asks the user for something or
  says something. An `action` step fires a side effect (for example, submitting a
  contact request). Each action has a type, and the platform only allows an action
  the agent holds the capability for.
- **Transitions** — the edges between steps, each with a guard that decides when
  the edge is taken.
- **Terminals** — where the flow ends: `complete` (done) or `handoff` (escalate
  to a person).

## Guards

A transition's guard decides, on a turn, whether its edge is taken. Most guards
are resolved without a model call, so the flow is predictable:

- `default` — the unconditioned edge. If it is the only exit, the engine takes
  it immediately. If there are conditioned sibling edges, it is the last resort
  after those siblings do not match.
- `slot_filled` — take it once the named slots are present.
- `outcome` — take it based on the result of the preceding action.
- `counter` — allow a bounded retry while a step is still under its attempt
  limit. Once the counter is exhausted, the default edge is forced. This is how
  "try twice, then hand off" works, with a real count rather than the model
  guessing.
- `llm` — the model judges a described condition by meaning. This is the only
  guard that consults the model, and it is the only place a transition can vary.

Like directive conditions, an `llm` guard is never a keyword list. Radioso is
multilingual; the model judges by meaning, in any language.

## Engineer fixture notation

Routine document fixtures use a compact text notation for golden tests,
debugging, and diffs. This notation is **not an authoring surface**. Operators
author routines in the dashboard outline or, while it remains available, the
transitional form view.

The fixture serializer is canonical, so reflowing text on serialize is expected.
The format uses grammar tokens, not localized product copy.

Common markers:

- `@name` references a declared variable or registered action.
- `#id` references a flow target, either a step anchor or an end anchor.
- `{#id}` declares the stable id for a step.
- `-> #id` or `→ #id` creates a transition to a target.
- `↺N` marks a counter-bounded retry edge.
- `[status]` marks an outcome guard.
- `[needs @a, @b]` marks a `slot_filled` guard.
- `?` after a variable key marks it optional.

The fixture shape mirrors the routine draft:

```text
---
name: Contact support
trigger: visitor wants a person to follow up
priority: 10
---

## Variables
- email: email - where the team should reply
- message: text - what the visitor needs help with

## Steps
1. Ask for @email. {#ask_email}
   -> #ask_message

2. Ask what they need help with; save it as @message. {#ask_message}
   -> #send_contact

3. Run @contact.send. {#send_contact}
   -> #done [success]
   -> #retry ↺2
   -> #handoff

## Ends
- done [complete]: Confirm the request was sent.
- handoff [handoff]: Hand the visitor to a person.
```

Fixture parsing maps back to `RoutineDefinitionDraft`: front matter maps to the
routine name and activation, `## Variables` maps to slots, numbered anchored
items map to steps, transition lines map to guards, and `## Ends` maps to
terminals. The current stored enum values are:

- step kind: `chat`, `tool`, `action`
- guard kind: `llm`, `default`, `slot_filled`, `outcome`, `counter`
- terminal kind: `complete`, `handoff`

## How it runs

On each turn, before normal skill selection, the engine checks for a routine:

1. If a routine is already active for the session, it resumes at its saved step.
2. Otherwise it checks whether any of the agent's published routines should
   activate. Each routine registration carries trigger metadata:
   `{ description, priority }`.
3. The active step is captured, its slots are filled from the user's message, and
   the routine advances along the first guard that holds. A message that supplies
   several values at once can advance through several steps in one turn.
4. The current step is projected into a directive, so it steers the reply through
   the normal steering set.

A routine keeps its position and captured values in session state until it
completes or expires. If an action cannot run — for example, the agent no longer
holds its capability — the turn fails rather than confirming a success that did
not happen.

## Activation and clarification

Routine activation evaluates all eligible routine triggers together in one ranked
model call. The engine no longer asks each routine, one by one, whether it wants
the turn.

The ranked activation input is the latest user message plus the full eligible
routine list. Each routine contributes its trigger description and authored
priority. Capability gates are applied before ranking, so a gated-off routine is
not considered and cannot appear in a clarifying question.

The activation result is a per-routine confidence score and any activation
variables that can already be extracted from the original message. The decision
order is:

1. Drop candidates below the confidence floor.
2. If the top routine clears the margin over the runner-up, start it silently.
3. If the top candidates are too close but one of them has a unique highest
   authored priority, start that routine silently.
4. Otherwise ask one clarifying question with up to four options.

Priority is explicit operator arbitration. It breaks close calls only when one
candidate has a unique highest priority. If comparable candidates also tie on
priority, the assistant asks instead of guessing.

When the visitor answers a routine clarification, the pending choice resolves
before the next routine attempt. A chosen option starts the selected routine at
its first step and preserves activation variables extracted from the ambiguous
turn. "None of these" or an unrelated reply clears the pending clarification and
the latest message proceeds normally.

While a routine is active, clarification asks are suppressed, including turns the
routine yields as off-topic. The system may still record that candidates were
close, but it silently picks the top candidate so the active routine remains the
only state waiting on the visitor's next message.

## Authoring a routine

A routine is created and edited in the agent's **Routines** settings, or through
the authoring API under `/api/v1/agents/<agentId>/routines`. The flow is:

1. Create or edit a **draft** — its slots, steps, transitions, and terminals.
2. **Validate** it. The validator reports problems in plain terms: a step that
   cannot be reached, a missing terminal, an action the agent is not allowed to
   use, a transition that leads nowhere.
3. **Publish** it. Publishing checks the routine is valid and stores an immutable
   version. A published routine is what the chat runtime loads and runs.

Each published version is immutable; editing a routine creates a new draft and, on
publish, a new version.

## Where it lives

The routine **runtime** (activation, resume, guards, projecting a step into a
directive) is product-independent and lives in
`packages/conversation-engine/` against `packages/conversation-contract/`. The
authoring side — the data model, the compiler that turns a definition into the
runtime graph, the validator, and the repository — lives in
`backend/src/modules/routines/`. The engine runs the compiled graph; it never
reads the authoring data.

## Not built yet

`tool` steps — a routine step that dispatches a skill — are part of the model but
not available in this version, because no skill dispatcher is wired for routines
yet. The authoring surface rejects them until that lands. Export and import of
routines across agents, and versioning of an agent's whole configuration, are also
deliberate next steps rather than gaps.
