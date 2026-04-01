# Data Model: Configurable Answer Support Policy

## Answer Support Policy

- **Represents**: The workspace-scoped policy that decides how retrieval-backed answers are handled after unsupported substantive segments are detected.
- **Fields**:
  - `policy`: one of `strict`, `warn`, `off`
  - `defaulted`: whether the value came from the system default rather than an explicit stored value
- **Validation rules**:
  - only the three approved policy values are valid
  - older settings payloads that omit the value resolve to `strict`
- **Relationships**:
  - stored as part of workspace retrieval settings
  - consumed by both authenticated and anonymous/public chat flows

## Strict Unsupported Notice

- **Represents**: The bounded generated replacement notice used when `strict` mode removes unsupported substantive content.
- **Fields**:
  - `text`
  - `languageHint`
  - `generationStatus`
- **Validation rules**:
  - must be short and non-empty
  - must express non-verification or uncertainty only
  - must not introduce new factual claims
  - falls back to a generic non-verification notice if generation fails or output is unusable

## Answer Validation Diagnostics

- **Represents**: The stored turn-level metadata that explains what happened during post-generation support handling for one assistant turn.
- **Fields**:
  - `validationRan`
  - `answerModified`
  - `unsupportedSegmentCount`
  - `supportedSegmentCount`
  - `nonSubstantiveSegmentCount`
  - `answerSupportPolicy`
  - `segmentResults`
- **Validation rules**:
  - `answerSupportPolicy` must always be present for retrieval-backed answers after this feature ships
  - `answerModified` may differ by policy even when `unsupportedSegmentCount` is the same
- **Relationships**:
  - stored in existing chat answer audit metadata
  - surfaced through existing chat history/debug views

## Validated Answer Outcome

- **Represents**: The final delivered and persisted answer artifact after applying the active answer-support policy.
- **Fields**:
  - `answer`
  - `citations`
  - `answerSegments`
  - `answerOutcome`
  - `validation`
- **State rules**:
  - `strict` may replace unsupported segments and can downgrade the outcome
  - `warn` preserves answer text while retaining unsupported diagnostics
  - `off` preserves answer text without post-generation replacement
  - no-context refusal remains a separate outcome path
