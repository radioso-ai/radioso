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

The key point is the distinction: Skills act, Directives steer. A Directive has
no executor and produces no output. If a rule needs to *do* something, it is a
Skill, not a Directive.

## How it works

On each turn the assistant:

1. Matches the agent's standing directives against the turn.
2. Drops any directive the agent lacks the required capability for.
3. Renders the matched actions into the answer prompt as steering.

A directive condition is one of two kinds:

- `always` — the directive applies on every turn. This is resolved without a
  model call.
- `contextual` — the directive applies only when a described situation holds.
  The model judges whether the condition holds and returns a confidence; a
  contextual directive is injected only at or above a confidence threshold set
  in composition.

Matching is never a keyword list, because Radioso is multilingual. The model
judges a condition by meaning, in any language.

## One steering type

Authored Directives are not the only source of steering. A Skill can also emit
short-lived guidance as part of its result. Both share one value type,
`SteeringRule`, so the answer composer reads a single ordered set rather than
two separate channels.

A `SteeringRule` carries the action, an optional condition, and optional
priority and criticality used for ordering. The turn assigns its source
(`directive` or `skill`) and lifespan when it merges the two sources.

## Relationships

Directives can relate to each other to keep the matched set small as the set
grows:

- `excludes` — when this directive applies, drop the named directives. A mutual
  exclusion resolves by priority; the higher-priority directive wins.
- `dependsOn` — this directive applies only if all named directives also apply
  this turn. Dropping a dependency cascades to its dependents.

The key point: relationships are resolved after the capability filter, so a
directive the agent is not authorized for can neither exclude nor satisfy
another. Each drop is recorded in the turn trace with its reason.

## Adding a directive

A directive is added in two places:

- a catalog entry that declares its condition and action, and
- registration in the agent's standing set at composition.

Nothing in the chat turn or the retrieval and skills modules needs to change.
The assistant's behavior changes by adding a rule, not by editing the turn loop.

## Practical implication

Behavioral rules live as small, named, individually matched units rather than
as one large system prompt. Each match is recorded in the turn's activity trace
with the reason it applied, so the steering on any answer can be inspected.
