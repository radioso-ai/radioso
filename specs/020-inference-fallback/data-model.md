# Data Model: Inference-Based Fallback Answers

## Modified Entities

### RetrievalSettings

**Change**: Add one new field.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| inferenceAnswerEnabled | boolean | false | When true, the system generates LLM answers from general knowledge when no documents match a query |

**Database column**: `inference_answer_enabled BOOLEAN NOT NULL DEFAULT FALSE`

**Migration**: `ALTER TABLE retrieval_settings ADD COLUMN inference_answer_enabled BOOLEAN NOT NULL DEFAULT FALSE;`

No index needed — this column is only read as part of the full settings row, never queried independently.

### ChatResponse (API payload)

**Change**: Add one new field to the response payload.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| source | `"retrieval"` \| `"inference"` | `"retrieval"` | Indicates whether the answer was grounded in documents or generated from general knowledge |

This field appears in:
- The JSON response body for non-streaming requests
- The `done` SSE event data for streaming requests

**Backward compatibility**: Existing consumers that do not read `source` are unaffected. The field defaults to `"retrieval"` for all document-grounded answers, preserving existing behavior.

## State Transitions

```
User sends query
  → Retrieval pipeline runs
    → contexts.length > 0?
      YES → build retrieval prompt → source: "retrieval"
      NO  → inferenceAnswerEnabled?
        YES → build inference prompt → call LLM → source: "inference"
          → LLM fails? → fall back to static message, source: "retrieval"
        NO  → return static message, source: "retrieval"
```

## No New Entities

This feature does not introduce any new database tables, new domain objects, or new relationships. It extends two existing structures with one field each.
