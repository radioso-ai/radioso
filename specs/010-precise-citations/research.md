# Research: Precise Citation Placement

## Decision 1: Use explicit citation anchors in model output

- **Decision**: The grounded prompt will require the model to cite retrieved sources through a strict numeric anchor syntax tied to retrieval result numbers.
- **Rationale**: Exact placement is only reliable when the generator declares where citations belong. Post-hoc text-overlap scoring cannot distinguish claim boundaries from URLs, prices, or connective prose.
- **Alternatives considered**:
  - Keep heuristic placement and improve tokenization: rejected because the failure mode is structural, not just token quality.
  - Push anchor parsing to the frontend: rejected because the backend owns trust, validation, and response normalization.

## Decision 2: Normalize anchors into the existing response shape

- **Decision**: The backend will strip raw anchors from the visible answer and emit normalized `citations` plus `answerSegments` for completed responses.
- **Rationale**: This preserves current frontend behavior and avoids exposing raw model syntax directly to users.
- **Alternatives considered**:
  - Return raw answer text with inline anchors only: rejected because the frontend would need to parse model syntax and handle malformed anchors.
  - Introduce a brand-new response contract: rejected because the existing shape already models exact placement well enough.

## Decision 3: Finalize precise placement only on completion for streaming

- **Decision**: SSE chunk events remain plain text; citation normalization happens once the full answer is available.
- **Rationale**: Partial streams can split anchors across chunks, so final normalization must operate on the complete answer.
- **Alternatives considered**:
  - Stream incremental citation metadata: rejected because the current transport is text-first and chunk-safe normalization would add complexity outside the approved scope.

## Decision 4: Drop malformed or unknown anchors safely

- **Decision**: Unknown, malformed, or incomplete anchors are removed from rendered citation metadata and do not become visible markers.
- **Rationale**: Safe degradation is preferable to guessing or showing misleading markers.
- **Alternatives considered**:
  - Attempt to repair invalid anchors heuristically: rejected because that reintroduces the ambiguity this feature is removing.
