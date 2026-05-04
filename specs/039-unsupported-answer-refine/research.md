# Research: Conversational Unsupported Answers

## Decision 1: Introduce a focused grounded-miss response composer

- **Decision**: Add a dedicated backend service that composes conversational
  responses for two cases: fully unsupported strict-mode answers with retrieved
  context, and no-context refusals.
- **Rationale**: The current behavior is split between `chatService.ts` and
  `answerSupportValidator.ts`. A focused composer keeps wording rules out of
  orchestration while allowing the same bounded logic to be reused across chat
  and tests.
- **Alternatives considered**:
  - Add more branching inside `chatService.ts`: rejected because the spec and
    constitution both require that file to remain orchestration-only.
  - Move the logic into retrieval services: rejected because retrieval should
    not own user-visible copy composition.

## Decision 2: Limit the refinement to fully unsupported strict-mode answers and no-context responses

- **Decision**: Keep mixed supported/unsupported strict-mode answers on the
  existing validator path, but refine the cases where the user would otherwise
  see only a hard-coded unsupported notice or a hard-coded no-context refusal.
- **Rationale**: The issue is about dead-end responses when the system does not
  have a supported answer. Mixed answers already preserve grounded content, so
  the higher-value refinement is the fully unsupported and no-context surfaces.
- **Alternatives considered**:
  - Rewrite every unsupported segment path to be conversational: rejected
    because it would blur the current validator semantics and create more copy
    churn than the approved scope requires.

## Decision 3: Keep adjacent suggestions bounded to already retrieved material

- **Decision**: The composer may reference only titles and content already
  retrieved for the current turn. It must not request a second search or answer
  from generic model knowledge.
- **Rationale**: This preserves the product's grounding contract and matches the
  approved anti-goals.
- **Alternatives considered**:
  - Allow generic model fallback when no answer is found: rejected because the
    approved spec explicitly forbids introducing a new ungrounded fallback mode.

## Decision 4: Use deterministic fallback copy and optional model-assisted phrasing

- **Decision**: The default composer will produce deterministic safe copy for
  tests and fallback behavior, while the production registry will inject a
  model-backed composer using the existing chat model to improve phrasing.
- **Rationale**: The repo already uses this pattern for unsupported notices. It
  keeps tests stable while allowing production to generate more natural wording
  from bounded inputs.
- **Alternatives considered**:
  - Deterministic-only copy: rejected because the feature specifically aims to
    make the responses feel more natural.
  - Model-only copy with no fallback: rejected because safe failure is required
    by the constitution.

## Decision 5: Keep diagnostics and outcome enums unchanged

- **Decision**: Preserve `grounded_success`,
  `grounded_degraded_unsupported_segments`, and `no_context_refusal` as-is.
- **Rationale**: The feature changes presentation, not outcome semantics, and
  existing history/debug flows already rely on these distinctions.
- **Alternatives considered**:
  - Add a new outcome for conversational misses: rejected because it creates new
    product and audit semantics outside the approved scope.
