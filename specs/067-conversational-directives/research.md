# Research & Design Notes: Conversational Directives

This note records the design rationale behind `067` and sketches the `SteeringRule` extraction that slice 1 performs. It argues why a Directive is *not* a Skill, shows that the steering shape already exists in the codebase, and works the extraction against the current `SkillTransientGuidance` so the unification is concrete before any code is written.

> Per the constitution, implementation does not begin until this spec is approved. The TypeScript below is a **design sketch**, not applied code. The one production type it builds on (`SkillTransientGuidance`) is reproduced verbatim from `backend/src/modules/skills/skillExecutorRegistry.ts` as it stands today.

## The unit that was missing

The assistant-as-spine model (`066`) made the turn loop select and dispatch **Skills** — capabilities, things the agent can *do*. But a conversational agent also needs to decide *how to behave*: tone, caution, when to confirm, when to prefer a human. None of that is a capability. Today it has nowhere to live except a growing system prompt — the monolith the spine exists to escape.

A **Directive** is that missing unit: an authored, standing `condition → action` rule the loop **matches** per turn and **injects into composition**. The distinction from a Skill is sharp and load-bearing:

| | Skill | Directive |
|---|---|---|
| Verb | **acts** | **steers** |
| Lifecycle | dispatched → returns an outcome | matched → injected into compose context |
| Port | `SkillExecutorPort.dispatch()` | `DirectiveMatcherPort.match()` |
| Returns | a control envelope (`SkillOutcome`) | nothing — it shapes the LLM's response |
| Has an executor? | yes | **no — by type** |

If a Directive ever grows a `dispatch()`, it has become a malformed Skill and the catalog stops meaning anything. The boundary is enforced by the type (no executor field, no result channel), not by discipline.

## The steering shape already exists

The keystone observation: `066` already shipped a `condition → action` steering shape — it just lives on the skill-outcome side. From `backend/src/modules/skills/skillExecutorRegistry.ts`:

```ts
/** Transient, single-turn steering a skill can inject (condition/action pair). */
export interface SkillTransientGuidance {
  action: string;
  condition?: string;
  priority?: number;
  criticality?: "low" | "medium" | "high";
  description?: string;
}
```

A Directive *is* this shape. The only differences are **source** (authored standing set vs. skill-emitted) and **lifespan** (matched-per-turn vs. one turn). Modeling them as two types would guarantee drift and two prompt-injection paths into the composer. So slice 1 lifts the shared shape into one value type and feeds one ordered steering set.

## The `SteeringRule` extraction (slice 1)

Introduce the shared type, then redefine `SkillTransientGuidance` in terms of it with **no field divergence**:

```ts
// shared steering shape — the one vocabulary the composer reads
export interface SteeringRule {
  action: string;                                  // instruction to the composer, NOT literal user copy
  condition?: string;
  priority?: number;
  criticality?: "low" | "medium" | "high";
  description?: string;
  source: "directive" | "skill";                  // where it came from
  lifespan: "response" | "session";               // how long it holds
}

// the skill-emitted guidance is now just a SteeringRule with source pre-bound.
// Field shape is identical to today's SkillTransientGuidance, so the existing
// emit path is behavior-preserved; the loop tags source/lifespan when it merges.
export type SkillTransientGuidance = Omit<SteeringRule, "source" | "lifespan"> &
  Partial<Pick<SteeringRule, "lifespan">>;
```

`source`/`lifespan` are *assigned by the loop at merge time*, not authored on the skill side — so the skill executor's emitted object is unchanged and the existing `SkillOutcome.guidance` path keeps compiling. The composer stops reading `SkillTransientGuidance[]` and starts reading one `SteeringRule[]`.

A type-level assertion guards against drift (mirroring the `_SkillDefinitionContractAssertion` pattern already in `skills/domain.ts`):

```ts
// fails the build if the skill-emitted guidance shape ever diverges from SteeringRule
type _GuidanceIsSteeringRule = SkillTransientGuidance extends Omit<SteeringRule, "source" | "lifespan">
  ? true : never;
const _guidanceIsSteeringRule: _GuidanceIsSteeringRule = true;
void _guidanceIsSteeringRule;
```

## The Directive contract and matcher port

A Directive carries the steering payload plus a structured condition — and pointedly **no executor**:

```ts
// directives/domain.ts — pure declarative data, no execution
export type DirectiveCondition =
  | { kind: "always" }                              // deterministic; no model call
  | { kind: "contextual"; description: string };    // probabilistic; LLM-matched, multilingual

export interface Directive {
  name: string;
  condition: DirectiveCondition;
  action: string;                                   // composer instruction, LLM-consumed
  priority?: number;
  criticality?: "low" | "medium" | "high";
  requiredCapabilities?: string[];
  description?: string;
  // NOTE: no `execution`, no `dispatch`, no `outputs`. Steer-Not-Act is structural.
}

// directives/directiveMatcher.ts — the per-turn match port (sibling to skill selection)
export interface DirectiveMatch {
  directive: Directive;
  selectionMode: "deterministic" | "probabilistic"; // reuse SkillDiagnostic's vocabulary
  selectionReason: string;
  selectionConfidence?: number;
}

export interface DirectiveMatcherPort {
  match(input: {
    turnContext: Record<string, unknown>;
    directives: Directive[];
  }): Promise<DirectiveMatch[]>;
}
```

A matched Directive becomes a `SteeringRule` at merge time:

```ts
const toSteeringRule = (m: DirectiveMatch): SteeringRule => ({
  action: m.directive.action,
  condition: m.directive.condition.kind === "contextual"
    ? m.directive.condition.description
    : undefined,
  priority: m.directive.priority,
  criticality: m.directive.criticality,
  description: m.directive.description,
  source: "directive",
  lifespan: "response",
});
```

## Where it slots — today vs. after `066`

`SkillOutcome.guidance` is consumed by no runtime code today (`grep -rn '\.guidance' backend/src` finds zero readers), and the `066` gather→select→dispatch loop is not yet built. So slice 1 does **not** wait on `066`: it injects at today's single compose point, `ChatService.composeGroundedSystemPrompt`.

**Slice 1 (today's architecture, no `066`):**

```
 user turn ──▶  chat path
                  ├─▶ directiveMatcher.match(ctx, standingSet) ─▶ matches      │  ← 067
                  ▼
              composeGroundedSystemPrompt(base, steering = matches▸SteeringRule[])  ← create the sink here
                  ▼
              chatGateway.answer(systemPrompt, …)
```

**After `066`'s loop lands (slices 3–4, additive):** the same `SteeringRule[]` gains a second source — skill-emitted `SkillOutcome.guidance` — and matched Directives also flow to the selector as soft signals:

```
                  ├─▶ directiveMatcher.match ─────────────▶ matches ───────────┐
                  ├─▶ skillSelector.select(ctx, matches) ─▶ chosen skills      │  ← slice 4
                  ├─▶ dispatch skills ─▶ SkillOutcome(.guidance) ──────────────┤
                  ▼                                                            ▼
              compose(ctx, steering = matches▸SteeringRule[] + guidance▸…)        ← one sink, two sources (slice 3)
```

Either way the compose path consumes one ordered `SteeringRule[]` (sort by `priority` then `criticality`) and gains no directive-specific branches. Adding a Directive is a catalog entry + standing-set inclusion — zero compose edits (SC-001).

## Decisions captured

- **Steer, don't act.** A Directive has a `match` port, never a `dispatch`. No executor field, no outputs. Enforced by type (SC-002).
- **One steering vocabulary.** `SteeringRule` unifies authored Directives and skill-emitted guidance; `SkillTransientGuidance` is redefined in its terms with a drift guard. The composer reads one `SteeringRule[]` (SC-003).
- **`source`/`lifespan` are loop-assigned.** The skill emit path is unchanged; the loop tags provenance at merge time, keeping `066` behavior-preserved.
- **Selection is auditable.** Reuse `SkillDiagnostic`'s `selectionMode`/`selectionReason`/`selectionConfidence`; record every match and capability-omission in the activity trace (SC-004).
- **Conditions are LLM-matched or `always`.** No keyword lists. The contextual matcher's prompt lives under `backend/prompts/` and returns a structured matched-id decision; the confidence threshold is composition/settings-owned (SC-005).
- **One-directional skill coupling.** A Directive never names a skill; the *selector* reads matches as soft signals. Any future skill affordance is consumed by the selector, never executed by the Directive.
- **No new persistence.** The standing set is composition-resolved, like the default skill catalog and the `066` orchestration strategy. A runtime-authored directive store is a later spec.

## What slice 1 changed (delivered)

- `backend/src/shared/domain/steeringRule.ts` (new) — the shared `SteeringRule` value type + `orderSteeringRules` (priority desc, then criticality).
- `backend/src/modules/skills/skillExecutorRegistry.ts` — `SkillTransientGuidance` redefined as `Omit<SteeringRule, "source" | "lifespan">` with a build-time drift guard. Behavior-preserving; the executor still emits the bare rule and the loop tags provenance.
- `backend/src/modules/directives/` (new) — `Directive` contract (no executor), `DirectiveCondition`, `DirectiveCatalogRegistry`, `DirectiveMatcherPort` + deterministic `AlwaysMatchDirectiveMatcher`, and `DirectiveSteeringService` (matches → capability-filters → ordered `SteeringRule[]`). Depends on no other domain module. Plus `public.ts`, `composition.ts`, and a module `README.md`.
- `backend/prompts/chat/steering.md` (new) — the steering block template (header is prompt-owned, not hard-coded in code).
- `backend/src/modules/chat/services/groundedAnswerPromptComposer.ts` — accepts an optional `steering: SteeringRule[]` and renders directive actions into the system prompt; identical output when steering is empty.
- `backend/src/modules/chat/services/chatSessionPreparer.ts` — resolves steering once per turn (via an injected `DirectiveSteeringPort`, default `noopDirectiveSteering`) and carries the result on `PreparedSession`.
- `backend/src/modules/chat/services/chatService.ts` — forwards the port to the preparer and reads `session.directiveSteering.rules` at the single compose point.
- `backend/src/modules/chat/services/directiveTracePresenter.ts` (new) — appends a `directive_steering` stage (matched + omitted directives, with selection mode/reason) to the turn's activity trace via the public `ActivityTrace` contract; no-ops when nothing matched.
- `backend/src/modules/chat/services/chatTurnLifecycle.ts` — wraps `appendAnswerOutcome` with the directive stage at the single trace chokepoint.
- `backend/src/app/server/dependencyBuilders.ts` — wires an empty-standing-set `DirectiveSteeringService` into `ChatService` at composition.
- Tests (TDD, written first): `steering-rule.test.ts` (unification + ordering), `directives.test.ts` (registry, matcher, mapping, capability omission, no-executor guard), `grounded-answer-steering.test.ts` (compose injection + behavior parity), `directive-trace.test.ts` (activity-trace parity).

Behavior is unchanged by default: the standing directive set is empty, so steering is empty, the system prompt is identical, and the trace is untouched. The path is fully live — registering one always-match Directive at composition makes it steer with zero changes to the chat loop or the retrieval/skills modules (SC-001).

Slices 3–4 (skill-guidance convergence, skill-selection biasing) ride on the `066` loop once it consumes skill outcomes — additively, on the same sink.

## What slice 5 changed (delivered)

Directive relationships — the context-narrowing lever that lets many directives coexist:

- `Directive` gains `dependsOn?: string[]` and `excludes?: string[]`.
- `resolveDirectiveRelationships(matches)` (pure, in `domain.ts`) resolves the matched set in two ordered phases: **excludes** (an applying directive drops its excluded targets; processed in priority order so a mutual exclusion resolves deterministically — higher priority wins) then **dependsOn** (a directive applies only if all dependencies survive, resolved to a fixpoint so a dropped dependency cascades). It returns the kept matches plus an omission per drop (`excluded_by:<name>` / `unmet_dependency:<name>`).
- `DirectiveSteeringService.steer` applies it **after** the capability filter — a denied directive never applied, so it can neither exclude nor satisfy others — and merges the relationship omissions into the trace omissions.

Standalone on today's composer; no `066` dependency.

## What slice 2 changed (delivered)

The probabilistic matcher for `contextual` directives, standalone on today's composer (FR-009):

- `backend/prompts/chat/directive-match.md` (new) — system prompt: given candidate directives (name + condition) and the turn signals, return a JSON array of `{ name, confidence, reason }` for the conditions that hold. Multilingual by instruction; not a keyword list.
- `backend/src/modules/directives/directiveMatchPrompt.ts` (new) — loads the system prompt and builds the user prompt (candidate conditions + turn context; directive `action`s are withheld — the model decides *whether*, not *what*).
- `backend/src/modules/directives/directiveMatchParser.ts` (new) — extracts the first JSON array from the response (tolerating prose/code fences), keeps only known directive names, clamps confidence to `[0,1]`.
- `backend/src/modules/directives/probabilisticDirectiveMatcher.ts` (new) — `DirectiveMatchGateway` port + `ModelDirectiveMatchGateway` (over `TextGenerationClient`, mirroring the query-rewrite gateway pattern) + `ProbabilisticDirectiveMatcher`. The matcher forwards only `contextual` directives, makes no model call when there are none, and keeps classifications at or above the threshold as `selectionMode: "probabilistic"` matches carrying `selectionConfidence`/`selectionReason`.
- `backend/src/modules/directives/compositeDirectiveMatcher.ts` (new) — runs the deterministic always-matcher and the probabilistic matcher and concatenates, so a turn picks up both standing and conditional directives.
- `backend/src/shared/domain/behaviorConfig.ts` — `DIRECTIVES_BEHAVIOR.contextualMatchConfidenceThreshold` (composition-owned default, never tuned per phrase).
- `backend/src/modules/directives/composition.ts` — `createDirectiveMatcher` assembles always-only or always+probabilistic depending on whether a text client is given; `createDirectiveSteering` accepts a `textGenerationClient`/`matcher`.
- `backend/src/app/server/dependencyBuilders.ts` — wires the chat text client into the steering service so the contextual path is live.
- Tests (TDD): parser robustness, prompt rendering, the matcher's contextual-only forwarding + threshold + no-call-when-empty, composite merge, and the model gateway end to end with a stub client.

Behavior is still unchanged by default: the standing set is empty, so the composite matcher returns nothing and the probabilistic matcher never calls the model. Registering a `contextual` directive activates the LLM path with zero changes to the chat loop.

Product docs for the act-vs-steer model (FR-012 / SC-006) shipped in slice 1 and now note that contextual matching is live.
