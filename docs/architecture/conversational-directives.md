---
title: "Conversational Directives"
description: "Rules that shape how the assistant behaves per turn by matching conditions, injecting steering instructions, and optionally routing to a skill."
last_updated: 2026-08-24
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
4. Renders every matched `always` action and its matched dependencies into the
   answer prompt as steering.
5. Ranks the contextual matches by confidence and priority, then renders the
   highest-signal set that fits the contextual count and token limits. The turn
   trace records every contextual match held back by either limit.

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

Alongside the candidates, the matcher sees the turn's signals: the query, the
route, and the visitor context resolved for that turn. Context arrives as the
redacted snapshot, so a value the operator declared sensitive reaches the
matcher as `[redacted]`, and page context is reduced to the fields that locate
the visitor (URL, title, locale) rather than the page excerpt. The projection is
bounded by `CONTEXT_VARIABLES_BEHAVIOR.matchBound`: values longer than the
per-value limit are clamped with a truncation marker, and variables past the
count cap or section budget are dropped. Both classification surfaces read the
same projection — the standalone matcher call and the fused turn planner, which
renders it inside its directive section so routing, rewrite, and language
decisions stay firewalled from visitor state.

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

A `SteeringRule` carries the action, an optional condition, an optional
priority used for ordering, and the generators it addresses. The turn assigns
its source (`directive` or `skill`) and lifespan when it merges the two
sources.

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

## Where a directive applies

A turn writes more than one piece of visitor-facing text. The agent's reply is
one; the follow-up questions offered underneath it are another, written to their
own rules — on the grounded path both come back in a single answer envelope, so
the two rule sets share one prompt and the prompt states the boundary between
them. A directive that governs one of them
does not necessarily govern the other: "never suggest a follow-up question about
price" belongs to the question generator, while the answer itself may still
quote a price the visitor asked for.

`surfaces` names the generators a directive addresses, from a closed vocabulary
(`backend/src/shared/domain/generationSurface.ts`):

| Surface | The text it governs |
| --- | --- |
| `answer` | The agent's reply, and the clarifying question that speaks in the same voice. |
| `suggested_questions` | The follow-up questions offered to the visitor after an answer. |

An empty `surfaces` means `answer`, so a directive that names no surface shapes
the agent's reply and leaves the follow-up questions to their own rules. The
agent editor surfaces this as **Where this applies**, a pair of choices with the
reply selected. A directive addresses at least one generator, so the last
selected choice stays selected.

Each generator renders the rules addressed to it inside its own prompt block,
next to that generator's standing rules. Those standing rules hold: a directive
narrows what a generator may write, and the generator's own constraints — what
it may ground a suggestion on, what it may reveal from an excerpt — apply
whatever the directive says.

`surfaces` is orthogonal to `routes`. A route picks which turn path a directive
applies on; a surface picks which generator inside that turn it speaks to.

### What the scope governs

Scope reaches every decision that acts on behalf of a single generator, not only
prompt text:

- **Rendering.** Each generator renders the rules addressed to it.
- **Skill binding.** Binding decides which skill answers the turn, so only a
  directive addressed to `answer` can claim it. One scoped away from the answer
  steers its own generator and has no say in who replies.
- **Relationships.** `excludes` and `dependsOn` resolve per generator. "Replaces"
  means "when this applies, cancel that one and run instead" — a claim about how
  one generator behaves — so a directive cannot cancel one it never competes
  with. A directive that survives on some of its surfaces and loses on others
  keeps the surfaces it survived on, and still steers where it won.
- **Lifecycle.** A `once_per_conversation` or `cooldown` directive counts as
  fired when a generator it addresses **ran** — that is, when that generator's
  rules reached the model and its output was kept. Producing nothing still counts:
  a directive whose purpose is to suppress follow-up questions leaves none, and it
  applied. Keying the budget on visible output instead would leave exactly those
  rules unable to satisfy `once_per_conversation`, re-firing forever. The budget
  is preserved when the generator did not run at all: suggestions switched off,
  a count of zero, nothing retrieved, or a draft replaced by a decline.

  Whether the visitor *saw* anything is tracked separately, as
  `renderedSurfaces` in the trace, because it answers a different question.
- **Rule identity.** The same action addressed to two generators is two rules.

The two blocks share one system prompt, so the prompts say the boundary out
loud: the answer directives state that their reach is the answer text, and the
suggestion rules state that only directives in their own section govern what may
be suggested. Without that, a model reading "follow these when forming your
response" would apply an answer rule to the suggestions too.

The turn's activity trace records the surfaces each matched directive resolved
to, plus `renderedSurfaces` — the generators that actually produced output. Read
together they tell a rule that shaped the reply from one that shaped the
follow-up questions from one whose generator never ran. `pendingSurfaces` is
narrower and lifecycle-only: the once/cooldown directives whose budget is still
unspent because their generator had not rendered.

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
states what the agent should do when the directive fires), **Where this
applies**, **Replaces**, and **Priority**.

## Practical implication

Behavioral rules live as small, named, individually matched units rather than
as one large system prompt. Each match is recorded in the turn's activity trace
with the reason it applied, so the steering on any answer can be inspected.
