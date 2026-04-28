# Contract Notes: Retrieval Settings Conversation Mode

## Purpose

Document the approved additive contract changes for workspace settings and chat
debug behavior before implementation.

## Retrieval Settings API

- The authenticated retrieval settings endpoints remain:
  - `GET /api/v1/settings/retrieval`
  - `PUT /api/v1/settings/retrieval`
- The payload remains backward-compatible and additive.
- New retrieval settings field:
  - `conversationMode`
- Supported values:
  - `factual`
  - `guided`
  - `exploratory`
- Default behavior:
  - workspaces with no stored value receive `guided` on read

## Behavioral Contract Notes

- `conversationMode` shapes the response behavior for grounded success,
  degraded/unsupported, and no-context turns, but it does not replace
  `answerPolicy`.
- Explicit user requests for brevity or “just the answer” may suppress optional
  guided/exploratory expansion for the current turn without changing the stored
  workspace default.
- The code-first source of truth for settings schema changes remains
  `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` are generated artifacts and
  must be regenerated after implementation; they are not design-time sources of
  truth.

## Chat Diagnostics / History Notes

- Stored assistant-turn metadata should include:
  - `conversationMode`
  - whether expansion was applied
  - whether brevity override was applied
- Existing debug/history payloads should continue exposing answer-support
  details alongside the new conversation-mode metadata.
- These are additive changes to existing chat/history contracts rather than a
  new endpoint family.
