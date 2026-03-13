# Research: Strict Grounding

## Decision 1: Treat the configured similarity threshold as a hard floor

- **Decision**: Retrieval will stop using threshold fallback for chat-answer
  grounding. The configured account threshold becomes the minimum similarity
  allowed for answer-supporting candidates.
- **Rationale**: The current fallback broadens recall by admitting weaker
  matches. Because chat generation only refuses when no contexts are returned,
  a permissive fallback can admit unrelated chunks and unlock unsupported
  answers.
- **Alternatives considered**:
  - Keep fallback and raise the relaxed floor. Rejected because any relaxed
    floor still weakens the explicit account threshold and preserves the same
    failure mode.
  - Add prompt-only restrictions. Rejected because prompt wording is not a
    reliable safeguard once unrelated context has already been admitted.

## Decision 2: Raise the default first-pass candidate count modestly

- **Decision**: Increase the default retrieval candidate count for new
  default-setting accounts while leaving saved per-account values unchanged.
- **Rationale**: A modestly broader candidate pool protects recall for
  document-backed questions without weakening the relevance floor.
- **Alternatives considered**:
  - Leave the default candidate count unchanged. Rejected because strict
    thresholding could reduce answerability for borderline but valid questions.
  - Rewrite existing stored account settings. Rejected because it would expand
    rollout scope and silently change tenant-specific behavior.

## Decision 3: Preserve the existing chat API contract

- **Decision**: Keep the `/api/v1/chat/` request and response schema unchanged.
  The safeguard changes retrieval admission behavior only.
- **Rationale**: Clients already handle the current safe refusal response and do
  not need a transport-level change to benefit from stricter grounding.
- **Alternatives considered**:
  - Add a new response field that explains the refusal reason. Rejected for this
    feature because the approved scope is retrieval policy tightening, not API
    expansion.

## Decision 4: Cover the behavior with backend tests at multiple levels

- **Decision**: Add unit coverage for retrieval threshold behavior and contract
  or integration coverage for out-of-corpus refusal and preserved answerability.
- **Rationale**: The regression spans both retrieval-domain logic and observable
  chat behavior, so the safeguard must be verified at both layers.
- **Alternatives considered**:
  - Rely only on unit tests. Rejected because the user-visible failure happened
    at the chat endpoint boundary.
  - Rely only on integration tests. Rejected because domain-level coverage is
    needed to keep the threshold policy stable during future retrieval changes.
