# Data Model: Answer Support Validator

## 1. Answer Segment Validation Result

Per-segment decision produced after answer normalization and before assistant-turn persistence or final delivery.

### Fields

- `text`: Final visible text for the segment after validation
- `originalText`: Original normalized segment text before validation
- `disposition`: `supported`, `unsupported`, or `non_substantive`
- `citationIndices`: Visible citation indices retained for supported segments
- `replacementApplied`: Boolean indicating whether the original segment text was replaced
- `reason`: Short machine-readable reason such as `has_support_reference`, `missing_support_reference`, or `non_substantive_text`

### Validation Rules

- `supported` segments must retain at least one valid citation index
- `unsupported` segments must not preserve the original substantive text in the final delivered answer
- `non_substantive` segments may omit citation indices
- `text` must be the unsupported notice when `replacementApplied` is true

## 2. Validated Answer Outcome

The final post-validation answer artifact used for response delivery and assistant-message persistence.

### Fields

- `answer`: Final delivered assistant answer text
- `answerSegments`: Final visible answer segments after unsupported replacements
- `citations`: Visible citations that remain referenced by supported segments
- `validationRan`: Whether support validation executed for this turn
- `answerModified`: Whether one or more unsupported substantive segments were replaced
- `unsupportedSegmentCount`: Number of unsupported substantive segments replaced
- `supportedSegmentCount`: Number of supported substantive segments retained
- `nonSubstantiveSegmentCount`: Number of retained non-substantive segments
- `segmentResults`: Ordered `Answer Segment Validation Result` list for diagnostics

### Validation Rules

- When all substantive segments are unsupported, `answer` contains only the unsupported notice text
- When all substantive segments are supported, `answerModified` is false
- Visible citations must match the final supported segments only

## 3. Assistant Turn Outcome

Persisted status for one assistant turn, distinct from transport success/failure.

### Values

- `grounded_success`: Retrieved context existed and no unsupported substantive segments were replaced
- `grounded_degraded_unsupported_segments`: Retrieved context existed and one or more unsupported substantive segments were replaced
- `no_context_refusal`: No relevant retrieved context existed and the existing no-information refusal was returned
- `generation_failed`: Model or orchestration failed before a validated answer could be delivered

### Validation Rules

- `grounded_degraded_unsupported_segments` must never be used when no contexts were retrieved
- `no_context_refusal` must remain distinct from validator-triggered degradation
- `generation_failed` is represented through the existing audit `eventStatus: failure`

## 4. Validation Debug Metadata

Structured assistant-turn diagnostics persisted in `chat.answer` audit metadata and replayed through chat history.

### Fields

- `answerOutcome`: `Assistant Turn Outcome`
- `validation`: object containing:
  - `ran`
  - `answerModified`
  - `unsupportedSegmentCount`
  - `supportedSegmentCount`
  - `nonSubstantiveSegmentCount`
- `segmentResults`: bounded array of segment dispositions and counts for engineer inspection

### Validation Rules

- Debug metadata must not store the raw unsupported substantive text once it has been replaced
- Debug metadata must be sufficient to explain why a turn was downgraded
- Debug metadata must remain bounded and safe for audit replay

## 5. Chat History Debug Payload Addition

Additive API/debug view built from audit metadata.

### Fields

- Existing fields: `eventStatus`, `recordedAt`, `stream`, `citationCount`, `retrievalInfo`, `retrievalTrace`, `errorMessage`
- New fields:
  - `answerOutcome`
  - `validation`

### Validation Rules

- Existing consumers that ignore the new fields continue to work
- `validation.ran` is true for retrieval-backed answers and false for no-context refusals

## 6. State Transitions

### Retrieval-Backed Answer

1. Retrieval pipeline returns contexts and prompt
2. Model answer is normalized into answer text plus answer segments
3. Validator classifies each segment and produces a `Validated Answer Outcome`
4. Assistant turn is persisted with the validated answer only
5. Audit metadata records `grounded_success` or `grounded_degraded_unsupported_segments`

### No-Context Refusal

1. Retrieval pipeline returns no contexts
2. Existing no-information refusal text is produced
3. Validation is skipped
4. Assistant turn is persisted with `answerOutcome = no_context_refusal`

### Failure

1. Retrieval or generation fails
2. Existing failure response path persists the generic apology
3. Audit event remains `eventStatus = failure`
