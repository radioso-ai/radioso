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

The generic directive defaults now live in `@radioso/conversation-defaults`:
catalog registration, deterministic/contextual matching, prompt construction,
classification parsing, relationship resolution, and steering-rule mapping.
This backend module owns Radioso product content and host composition around
those defaults.

A Directive **steers, it never acts**: it has no executor, no `dispatch`, and no
result channel. Skills act; Directives steer. This module depends on no other
domain module (not skills, not retrieval, not chat). Chat answer turns receive
route-scoped directive candidates and the matcher through the engine input, then
resolve the engine-produced matches through the same capability and relationship
filtering used by `DirectiveSteeringPort`. Direct retrieval surfaces still use
`DirectiveSteeringPort` directly.

Matching stays **stateless per turn**. Cross-turn firing policy
(`once_per_conversation` / `cooldown` / `repeatable`, the default) is an authored
`Directive.lifecycle` field enforced *outside* the matcher: the chat host loads a
conversation's firing memory, suppresses ineligible directives before matching,
and advances the memory at turn completion. A directive counts as "fired" only
when it renders into steering, not when it merely matched. The host calls the
named `partitionDirectivesByLifecycle` seam (eligible / tracked-for-capture /
suppressed split) rather than composing the eligibility primitives inline. See
`directiveLifecycle.ts` (pure eligibility + firing-state helpers + partition),
`directiveStateStore.ts` (the `DirectiveStateStore` port), the host wiring in
`../chat/services/conversationProcessTurnInput.ts` +
`../chat/services/directives/deferredDirectiveStateStore.ts`, and the
`directive_states` table (persistence in `db/repositories/directiveStateRepository.ts`).

## Public Surfaces

- `public.ts`: the `Directive` contract, package re-exports for the catalog and
  matcher defaults, the `DirectiveSteeringPort`, and the
  `createDirectiveSteering` composition helper.

`SteeringRule` itself is a shared value type in
`shared/domain/steeringRule.ts` — it unifies authored Directives with
skill-emitted `SkillTransientGuidance` so the composer reads one steering set.

## Read First

- `domain.ts`: the Radioso-facing `Directive` / `DirectiveCondition` /
  `DirectiveMatch` types and steering helpers retained for backend callers.
- `packages/conversation-defaults/src/`: generic catalog registry, matcher
  defaults, parser, prompt, and relationship helpers.
- `directiveSteeringService.ts`: matches the standing set, capability-filters,
  and maps survivors to an ordered `SteeringRule[]`; chat can also reuse its
  filtering after the engine matcher has already produced matches.
- `defaultAnswerDirectives.ts`: built-in answer steering registered by
  application composition.
- `../chat/services/routeScopedDirectiveSteering.ts`: host-side route enactment
  for composition-registered answer directives; it exposes the candidate catalog
  and matcher used by the conversation engine.
- `../chat/services/answerDirectiveRoutePolicy.ts`: chat-owned default route
  policy for built-in answer directives.

## Tests

- `cd backend && pnpm test -- tests/unit/directives.test.ts`
- `cd backend && pnpm test -- tests/unit/default-composition.test.ts`
- `cd backend && pnpm test -- tests/unit/directive-lifecycle-partition.test.ts` (lifecycle partition seam)
- `cd backend && pnpm test -- tests/unit/route-scoped-directive-steering.test.ts`
- `cd backend && pnpm test -- tests/unit/steering-rule.test.ts`
- `cd backend && pnpm test -- tests/unit/grounded-answer-steering.test.ts` (compose injection)
- `cd backend && pnpm test -- tests/unit/directive-trace.test.ts` (activity-trace parity)
