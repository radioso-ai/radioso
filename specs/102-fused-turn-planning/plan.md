# Implementation Plan: Fused Turn Planning

**Branch**: `investigate-five-llm-calls` | **Spec**: `spec.md`

## Summary

Add a host-side plan-then-apply optimization around the existing conversation
engine schedule. A `TurnPlanService` makes one bounded chat-tier classification
call. A per-turn coordinator memoizes its outcome and exposes plan-aware adapters
for the existing routine, interpretation, language, and directive seams. The
engine and public contracts remain unchanged.

## Technical Context

- **Language/runtime**: TypeScript, Node.js 24
- **Backend**: Express composition with the reusable conversation engine
- **Validation**: strict runtime validation of JSON-in-text output
- **Tests**: Vitest and the live conversation-quality eval harness
- **Persistence**: none; turn plans are ephemeral per-turn state
- **Prompt asset**: `backend/prompts/chat/turn-planning.md`
- **Rollout**: `CHAT_TURN_PLANNING_ENABLED` plus optional workspace allowlist

## Module Knowledge and Boundaries

- `TurnPlanService` knows the prompt, output schema, normalization, and semantic
  candidate validation. It does not decide routine activation or directive
  steering.
- `TurnPlanCoordinator` knows rollout eligibility, input bounds, memoization,
  and adapter selection. It does not reproduce owning-module policy.
- `RoutineRegistry` owns candidate eligibility, prefiltering, ranking decision,
  activation-variable application, and clarification policy.
- The directives module owns scope/lifecycle filtering and classification-to-
  steering resolution.
- `ChatService` and `WorkbenchReplayRunner` start the same gated plan, while
  `ChatTurnAssembly` consumes it through the shared live/replay execution path.
- Application composition assembles the planner gateway, gate, coordinator, and
  existing fallback implementations.
- `@radioso/conversation-engine` and `@radioso/conversation-contract` remain
  capability-neutral and unaware of fused planning.

## Implementation Phases

### Phase 1 - Behavior-preserving owning-module seams

Extract routine candidate preparation and ranked-decision application in
`packages/conversation-defaults`. Extract directive lifecycle eligibility and a
precomputed-classification resolution path in the directives runtime. Pin the
existing decisions with characterization tests.

### Phase 2 - Planner and plan-aware adapters

Create the prompt, service, strict parser, eligibility gate, lazy per-turn
handle, and adapters. Wire live and replay execution through application
composition. Preserve an all-or-nothing fallback to the existing staged calls.

### Phase 3 - Rollout, observability, and documentation

Add environment configuration, behavior bounds, `turn_planning` usage/trace
attribution, source annotations, module documentation, and architecture docs.

### Phase 4 - Verification

Run focused unit/integration tests, builds, deterministic local CI, then live
conversation-quality evals with planning disabled and enabled. Review outputs
for behavioral quality, not only aggregate pass/fail.

## Constitution Check

- **Spec first**: This repository artifact promotes the architecture explicitly
  approved by the user before implementation began.
- **Backend TDD**: Characterization and planner/adapter tests cover the extracted
  seams and behavior before delivery is accepted.
- **Stack discipline**: TypeScript/Node and existing provider abstractions only.
- **Secrets/configuration**: no secrets added; new environment keys are documented
  and represented in example/runtime configuration.
- **Modularity**: product policy remains in the routine and directive owners;
  broad orchestration only coordinates narrow ports.
- **Reliability**: failures degrade to the complete staged path; cancellation and
  timeouts are explicit.
- **API/contracts**: no HTTP, SDK, MCP, connector, worker, or queue contract
  changes. Message-queue impact: none; document dispatch, AMQP payloads, retries,
  queue tests, and queue docs are unaffected.
- **Documentation**: chat/directives module briefs, turn-spine architecture,
  usage taxonomy, and operator setup are updated.
- **Prompt ownership**: runtime prompt stays under `backend/prompts/chat/`.
- **Composition**: default runtime wiring is evaluated in
  `dependencyBuilders.ts`; domain rules remain outside composition.

## Risks and Mitigations

- **Behavior drift from a larger classifier prompt**: strict validation,
  owning-module policy, live A/B evals, and kill switch.
- **Split-brain decisions**: one memoized outcome and all-or-nothing fallback.
- **Completed-routine interception**: correction and semantic-reentry adapters
  pin the plan as bypassed before their claimed reply or resumed routine can
  consume planned language/directives.
- **Latency regression on failure**: bounded timeout; failed turns pay at most one
  wasted planner call before staged fallback.
- **Prompt growth**: bounded candidates and estimated prompt tokens.
- **Replay/live divergence**: shared coordinator and composition wiring.
