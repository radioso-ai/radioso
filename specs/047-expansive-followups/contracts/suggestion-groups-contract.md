# Contract Notes: Suggestion Groups

## Backend Response Shape

Exploratory chat responses continue to expose `suggestions`, but each suggestion
item becomes explicitly typed so the frontend can render grouped lanes without
local inference.

Expected additive contract direction:

```json
{
  "suggestions": [
    {
      "text": "What examples show the same pattern?",
      "kind": "deeper",
      "citation": {
        "documentId": "doc-1",
        "chunkId": "chunk-1",
        "title": "Example title"
      }
    },
    {
      "text": "How does this connect to the broader process?",
      "kind": "broader",
      "citation": {
        "documentId": "doc-2",
        "chunkId": "chunk-7",
        "title": "Related title"
      }
    }
  ]
}
```

## Behavioral Expectations

- `factual` mode may continue returning no suggestions.
- `guided` mode remains conservative and should not surface expansive `broader`
  discovery behavior.
- `exploratory` mode may return:
  - only `deeper` suggestions,
  - only `broader` suggestions,
  - both groups,
  - or no suggestions when grounding is insufficient.

## Frontend Rendering Contract

- Dashboard chat and public chat both group suggestions by `kind`.
- Empty groups are not rendered.
- Clicking a suggestion still sends the suggestion text plus the source assistant
  message ID.

## Compatibility Constraints

- Existing conversation history records that store suggestions without `kind`
  must remain renderable; the frontend should treat legacy suggestions as
  `deeper` for backward compatibility if needed.
- OpenAPI schemas and frontend API types must stay aligned with the runtime
  payload shape.
