---
title: "Conversational Directives"
description: "Rules that shape how the assistant behaves per turn by matching conditions, injecting steering instructions, and optionally routing to a skill."
last_updated: 2026-08-10
---

# Conversational Directives

A Directive is an authored rule that shapes how the assistant behaves on a
turn. It pairs a condition with an action: when the condition holds, the action
is added to the assistant's instructions for that turn.

An example: when the customer sounds anxious, slow down and confirm before
acting.

## Skills and Directives

Radioso has two kinds of unit the assistant works with on a turn.

- A **Skill** is something the assistant can *do* — retrieval, an order lookup.
  A skill is dispatched and returns a result.
- A **Directive** is something that shapes *how* the assistant behaves. It is
  matched and added to the prompt. It is never dispatched and returns nothing.

Skills act, Directives steer. A Directive has
no executor and produces no output. If a rule needs to *do* something, it is a
Skill, not a Directive.

A directive can also name a skill binding:

```json
{
  "binding": { "kind": "skill", "skillName": "order_lookup" }
}
```

The binding does not make the directive execute. It tells the turn loop to make
that enabled skill available when the directive already matched. External MCP
skills can claim the terminal turn. Retrieval skills are staged into the
agentic retrieval loop as lookup tools. The directive action is still rendered
as steering for the answer.

## How it works

On each turn the assistant:

1. Matches the agent's standing directives against the turn.
2. Drops any directive the agent lacks the required capability for.
3. Resolves any skill binding on the matched directives.
4. Renders the matched actions into the answer prompt as steering.

A directive condition is one of two kinds:

- `always` — the directive applies on every turn. This is resolved without a
  model call.
- `contextual` — the directive applies only when a described situation holds.
  The model judges whether the condition holds and returns a confidence; a
  contextual directive is injected only at or above a confidence threshold set
  in composition.

Matching is never a keyword list, because Radioso is multilingual. The model
judges a condition by meaning, in any language.

The matcher never sees bindings. It receives directive names and conditions, so
a binding cannot make a directive more or less likely to match.

Contextual matching is an enhancement on top of the deterministic set, and a turn
answers without it. Whether the workspace model configuration fails to resolve or
the classification call itself fails, the turn yields no contextual matches and is
steered by its `always` directives alone. The backend logs
`directive_contextual_match_unavailable` at warn level with the workspace id, the
classification source that gave up, and the error type and message. Watch that
event when an agent answers in a tone or format one of its conditional directives
should have set.

## Skill binding behavior

Bindings are optional. Create and update requests validate that the named skill
exists on the agent, is enabled, uses an agent-selectable invocation mode, and
is either:

- an external MCP skill (`kind: external_mcp`), which can settle the terminal
  turn with user-facing answer text
- a retrieval skill (`kind: retrieve`), which can be staged into the agentic
  retrieval loop as a directive-scoped lookup tool

Action skills (webhook, Slack, email, notify) settle with outputs only, so
binding them would render an empty reply; authoring rejects them with a
descriptive error. Agent config import preserves the binding by name even if the
target agent does not currently have that skill.

A directive shapes what the agent says next, so only a skill that can produce
or feed that reply — an external MCP skill or a retrieval skill — qualifies for
binding. Posting to Slack, sending an email, calling a webhook, or notifying a
human is a routine's job: give the routine an activation condition that matches
the same situation, and add the action skill as a step. The directive and the
routine can cover the same trigger; the directive steers the reply, the routine
step performs the send.

When several matched directives have bindings, Radioso chooses one winner:

1. higher directive priority wins; `null` priority ranks as `50`
2. higher matcher confidence wins; deterministic `always` matches rank as `1.0`
3. directive name ascending breaks the final tie

If a bound external MCP skill is later disabled, removed, no longer
turn-selectable, not registered as a runtime turn skill, or requires a capability
the workspace policy denies (external skills require `external_skills.invoke`,
enforced the same way routine dispatch enforces it), the binding is skipped. The
turn falls back to normal selection, the directive action still steers the
reply, and the trace records the skipped binding with the reason. The backend
also writes a warn log with workspace, agent, conversation, directive name,
skill name, and reason. It does not log message text or document content.

If a bound retrieval skill is later disabled, removed, no longer
agent-selectable, or requires a capability the workspace policy denies
(`retrieval.answer`), it is not staged as a lookup tool. Staged-only retrieval
bindings do not appear as terminal turn-skill selections because they are inputs
to the answer loop, not answer producers.

Routine turns are different. Active routine flow bypasses terminal turn
selection, so directive bindings do not run there. A directive with
`routine:<id>` or `step:<routineId>:<stepId>` scope tags can still steer the
routine step reply, but any skill binding on that scoped directive is inert.

## One steering type

Authored Directives are not the only source of steering. A Skill can also emit
short-lived guidance as part of its result. Both share one value type,
`SteeringRule`, so the answer composer reads a single ordered set rather than
two separate channels.

A `SteeringRule` carries the action, an optional condition, and an optional
priority used for ordering. The turn assigns its source (`directive` or `skill`)
and lifespan when it merges the two sources.

## Priority and precedence

A directive resolves against the others two ways, one soft and one hard.

- **Priority (soft).** An author may set a priority (0–100); leaving it unset
  defaults to 50. The matched rules are rendered in priority order, and the
  steering prompt tells the model that when two of them genuinely conflict it
  should follow the one listed earlier. Nothing is dropped — priority only
  steers which guidance wins a tussle, and the model makes the judgment, so it
  is best-effort. The built-in answer directives sit at `inline-supported-links`
  90, `represent-organization` 80, and `concise-readable-formatting` 60
  (`backend/src/modules/directives/defaultAnswerDirectives.ts`). The agent
  editor's Priority field shows this scale so an author can rank a new
  directive above, between, or below them.
- **Replaces (hard).** `excludes` deterministically removes the named directives
  from the matched set before rendering. In the agent editor this is surfaced as
  **Replaces** — "when this directive applies, cancel these and run instead" —
  a searchable picker where each selected directive shows as a removable pill.
  The per-built-in **Override** button is a shortcut that pre-selects that
  built-in. Use it when a built-in's behavior must be gone for sure, not merely
  outranked.

## Relationships

Directives can relate to each other to keep the matched set small as the set
grows:

- `excludes` — when this directive applies, drop the named directives. A mutual
  exclusion resolves by priority; the higher-priority directive wins.
- `dependsOn` — this directive applies only if all named directives also apply
  this turn. Dropping a dependency cascades to its dependents.

Relationships resolve after the capability filter, so a
directive the agent is not authorized for can neither exclude nor satisfy
another. Each drop is recorded in the turn trace with its reason.

## Adding a directive

A built-in directive is added in two places:

- a catalog entry that declares its condition and action, and
- registration in the agent's standing set at composition.

Nothing in the chat turn or the retrieval and skills modules needs to change.
The assistant's behavior changes by adding a rule, not by editing the turn loop.

An operator adds a directive to one agent from the agent editor's directive
dialog, no code involved. The fields are **Name**, **When this applies**
(`Always`, or `In a specific situation`, which opens a **Situation** field for
the condition's description), **Instruction** (the steering text — the
`action` field described above; the label reads "Instruction" because it
states what the agent should do when the directive fires), **Replaces**, and
**Priority**.

## Practical implication

Behavioral rules live as small, named, individually matched units rather than
as one large system prompt. Each match is recorded in the turn's activity trace
with the reason it applied, so the steering on any answer can be inspected.
