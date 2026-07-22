# Feature Specification: Fused Turn Planning

**Feature Branch**: `investigate-five-llm-calls`
**Created**: 2026-07-21
**Status**: Approved
**Source**: User-approved architecture in `.context/turn-planner-architecture.md`

## Goal

Reduce redundant model classification work on fresh assistant turns without
changing conversation behavior. On an eligible direct turn, Radioso should use
one fused planning call and one answer call. Retrieval, routine, directive, and
language policies remain owned by their existing modules.

## User Scenarios

### User Story 1 - Faster direct conversations (Priority: P1)

As a person chatting with an assistant, I receive the same relevant answer with
less latency and model cost because route selection, routine ranking, response
language selection, and directive classification share one planning call.

**Independent Test**: Run an eligible direct turn through streamed and
non-streamed paths and verify exactly one `turn_planning` model call plus one
answer-generation call, with no staged classification calls.

### User Story 2 - Safe degradation (Priority: P1)

As an operator, I know that invalid, timed-out, cancelled, or ineligible
planning attempts preserve the existing
staged behavior rather than silently losing routines, directives, language, or
routing behavior.

**Independent Test**: Exercise malformed output, unknown candidate identifiers,
provider errors, timeouts, cancellation, pre-engine bypasses, and over-bound
candidate/input sets; verify typed outcomes and the
complete staged fallback where applicable.

### User Story 3 - Observable replay parity (Priority: P2)

As an operator evaluating conversation quality, I can replay the same cases
through the production composition and observe whether a turn used planned or
staged classification, including usage attribution for the planner call.

**Independent Test**: Run the workbench replay and conversation-quality eval
paths through planned and staged-fallback turns, then compare routing, routines,
directives, language, grounding, and answer quality.

## Functional Requirements

- **FR-001**: The system MUST compute one strict, provider-neutral JSON turn plan
  for eligible fresh turns using the workspace chat-tier model.
- **FR-002**: A turn plan MUST include route/framing, an optional retrieval
  rewrite, an optional response language, routine rankings with any activation
  variables supplied in the latest user message, and directive classifications.
- **FR-003**: The planner MUST reject the whole plan when output is malformed or
  references a routine or directive outside the supplied candidate set.
- **FR-004**: All planner consumers MUST share one lazy, memoized per-turn
  outcome.
- **FR-005**: A planned outcome MUST replace the staged routine-ranking,
  turn-interpretation, response-language, and directive-classification model
  calls without moving decision policy into the planner.
- **FR-006**: A failed or bypassed plan MUST keep the existing staged behavior;
  a turn MUST NOT mix planned decisions with staged classification results.
- **FR-007**: Routine eligibility, prefiltering, activation, and clarification
  policy MUST remain in `RoutineRegistry`.
- **FR-008**: Directive scope, lifecycle eligibility, classification resolution,
  and steering MUST remain in the directives-owned runtime.
- **FR-009**: Planning MUST be standard behavior and require no rollout
  configuration.
- **FR-010**: Planning MUST bypass active/claimed routine flows and candidate or
  estimated-prompt sizes above configured bounds.
- **FR-011**: Planner calls MUST propagate cancellation and have a bounded
  timeout.
- **FR-012**: Planner usage MUST be attributed as `turn_planning`; traces MUST
  indicate planned versus staged sources without recording prompts or customer
  content.
- **FR-013**: Live chat and workbench replay MUST use the same composition and
  plan-aware adapters.
- **FR-014**: Runtime prompt assets MUST live under `backend/prompts/`.
- **FR-015**: The feature MUST NOT change public HTTP, SDK, MCP, connector,
  worker, or message-queue contracts.

## Edge Cases

- No routines or contextual directives are eligible.
- A routine claims the turn before normal answer routing, including completed-
  routine slot correction and semantic reentry interceptors.
- The planner returns duplicate, missing, or unknown candidate identifiers.
- Retrieval routing has an unusable rewrite while the remaining plan is valid.
- The caller aborts before or during the planning request.
- Prompt estimation or candidate counts are exactly at their configured bounds.

## Success Criteria

- **SC-001**: Eligible direct turns make exactly two model calls in both streamed
  and non-streamed execution: one plan and one answer.
- **SC-002**: Eligible retrieval turns make no legacy fresh-turn classification
  calls in addition to the plan; retrieval-specific model work remains allowed.
- **SC-003**: All failure and bypass cases retain staged behavior with no lost
  routine or directive decisions.
- **SC-004**: Deterministic tests, backend build, local CI, and live conversation
  quality evals pass across planned, bypassed, and failed turns.
- **SC-005**: Conversation review finds no material regression in routing,
  grounding, directive adherence, routine behavior, or response language.

## Out of Scope

- Collapsing active-routine, pending-clarification, or slot-correction flows.
- Guaranteeing two calls for retrieval turns.
- Provider-native structured-output APIs.
- Public or cross-service contract changes.
