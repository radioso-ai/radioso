# Contract: Chat Grounding Behavior

## Endpoint

- `POST /api/v1/chat/`

## Request

- No schema changes.
- Existing fields remain:
  - `query`
  - `stream`
  - `conversationId` (optional)

## Response

- No schema changes.
- Existing fields remain:
  - `conversationId`
  - `answer`
  - `citations`

## Behavioral Contract

- If relevant document context exists at or above the configured similarity
  threshold, the endpoint returns a grounded answer using the existing response
  shape.
- If no relevant document context exists at or above the configured similarity
  threshold, the endpoint returns the existing safe refusal response using the
  same response shape.
- The endpoint does not add new transport fields to explain threshold policy in
  this feature.
