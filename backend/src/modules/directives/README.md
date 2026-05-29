# Directives Module

Directives own **authored, standing behavioral steering** the assistant turn
matches per turn and injects into answer composition. A Directive is a
`condition → action` rule that shapes *how* the agent behaves — the standing
counterpart of a skill's transient guidance. Start here when a feature changes
how behavioral rules are declared, matched, capability-gated, or rendered into
the answer prompt.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).
The design rationale lives in `specs/067-conversational-directives/`.

## Boundaries

Directives know about `condition → action` rules, per-turn matching, and mapping
matched rules to the shared `SteeringRule` value type.

A Directive **steers, it never acts**: it has no executor, no `dispatch`, and no
result channel. Skills act; Directives steer. This module depends on no other
domain module (not skills, not retrieval, not chat). The chat module depends on
it through the `DirectiveSteeringPort`, receiving a `SteeringRule[]` plus trace
diagnostics — never Directives.

## Public Surfaces

- `public.ts`: the `Directive` contract, the catalog registry, the matcher port,
  the `DirectiveSteeringPort`, and the `createDirectiveSteering` composition
  helper.

`SteeringRule` itself is a shared value type in
`shared/domain/steeringRule.ts` — it unifies authored Directives with
skill-emitted `SkillTransientGuidance` so the composer reads one steering set.

## Read First

- `domain.ts`: the `Directive` / `DirectiveCondition` / `DirectiveMatch` types
  and `directiveToSteeringRule`.
- `directiveMatcher.ts`: `DirectiveMatcherPort` and the deterministic
  `AlwaysMatchDirectiveMatcher` (the v1 matcher; the probabilistic LLM matcher
  is a later slice).
- `directiveSteeringService.ts`: matches the standing set, capability-filters,
  and maps survivors to an ordered `SteeringRule[]`.

## Tests

- `cd backend && pnpm test -- tests/unit/directives.test.ts`
- `cd backend && pnpm test -- tests/unit/steering-rule.test.ts`
- `cd backend && pnpm test -- tests/unit/grounded-answer-steering.test.ts` (compose injection)
- `cd backend && pnpm test -- tests/unit/directive-trace.test.ts` (activity-trace parity)
