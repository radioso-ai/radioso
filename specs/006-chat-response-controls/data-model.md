# Data Model: Chat Response Controls

## 1. Response Preference

Account-scoped configuration that influences how assistant answers are generated and rendered.

### Fields

- `accountId`: Unique account identifier
- `queryRewriteEnabled`: Existing retrieval preference
- `rerankEnabled`: Existing retrieval preference
- `vectorTopK`: Existing retrieval preference
- `similarityThreshold`: Existing retrieval preference
- `rerankTopK`: Existing retrieval preference
- `warmthLevel`: Integer from `1` to `10`
- `citationDisplayEnabled`: Boolean controlling whether inline citation markers should be returned for rendering
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp

### Validation Rules

- `warmthLevel` must be an integer in the inclusive range `1..10`
- `citationDisplayEnabled` must be explicitly boolean
- Existing retrieval validation rules remain unchanged

### Notes

- `citationDisplayEnabled` exists to preserve optional citation rendering at the data-contract level
- Grounding and retrieval may still occur even when `citationDisplayEnabled` is `false`

## 2. Chat Answer

The final assistant response visible to the user.

### Fields

- `conversationId`: Conversation identifier
- `answer`: Plain readable answer text
- `citations`: Optional deduplicated source list available to the client
- `answerSegments`: Optional ordered segments of the answer with segment-level citation references

### Validation Rules

- `answer` is always required
- `citations` may be omitted or be an empty list
- `answerSegments` may be omitted when citation markers are disabled or when no structured markers are needed

## 3. Citation Reference

Renderable reference from the answer to retrieved support.

### Fields

- `documentId`: Source document identifier
- `chunkId`: Source chunk identifier
- `title`: Human-readable source label

### Validation Rules

- Each citation reference is unique by source chunk within the top-level citation list
- Duplicate references to the same source within a segment or adjacent equivalent support group should collapse to a single visible marker

## 4. Answer Segment

An ordered unit of answer content that may carry citation references.

### Fields

- `text`: Visible text for the segment
- `citationIndices`: Optional ordered references into the top-level `citations` list

### Validation Rules

- Segments must preserve the full answer order
- `citationIndices` must reference valid positions in the top-level citation list
- Empty citation arrays should be omitted rather than emitted as noise

## 5. State Transitions

### Response Preference

1. Defaulted for a new account
2. Retrieved for settings display
3. Updated by the user
4. Applied to subsequent chat answers

### Chat Answer

1. User request received
2. Account response preferences loaded
3. Retrieval pipeline produces supporting contexts
4. Answer instructions incorporate warmth and clarification policy
5. Assistant answer is generated
6. Citation references are deduplicated and mapped to answer segments when enabled
7. Final JSON or SSE completion payload is emitted
