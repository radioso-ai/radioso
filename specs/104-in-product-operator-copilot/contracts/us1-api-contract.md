# US1 API Contract — Operator Copilot (read-only troubleshooter)

Fixed contract for parallel backend/frontend implementation. Both sides code
against this document; changes to it require updating both streams.

All endpoints live under `/api/v1/copilot`, are **session-only** (reject
`res.locals.authMode === "bearer"` with 403 before any handler logic), and
require `workspace.agents.read`.

## Endpoints

### `GET /api/v1/copilot/availability`

Whether the copilot can run for this workspace/principal.

```json
{ "available": true, "reason": "ok" }
{ "available": false, "reason": "no_llm_capability" }
```

`reason`: `"ok" | "no_llm_capability"`. (Missing permission is a plain 403,
not an availability reason.)

### `GET /api/v1/copilot/conversations`

```json
{ "conversations": [ { "id": "uuid", "title": "string|null", "status": "idle|running", "createdAt": "iso", "updatedAt": "iso" } ] }
```

Ordered by `updatedAt` desc. `title` is a short label derived from the first
operator message (truncation, not an LLM call).

### `GET /api/v1/copilot/conversations/:conversationId`

```json
{
  "id": "uuid", "title": "string|null", "status": "idle|running",
  "messages": [
    { "id": "uuid", "role": "operator", "content": "string", "createdAt": "iso" },
    { "id": "uuid", "role": "copilot", "content": "string", "createdAt": "iso",
      "outcome": "completed|budget_exhausted|failed",
      "activity": [ { "tool": "string", "outcome": "completed|failed" } ] }
  ]
}
```

`activity[].tool` is the UI-safe tool label (see SSE `activity`), in
invocation order. 404 for another operator's or another workspace's
conversation.

### `DELETE /api/v1/copilot/conversations/:conversationId`

204. Deletes the conversation and its messages.

### `POST /api/v1/copilot/turns` → SSE stream

Request:

```json
{
  "conversationId": "uuid|null",
  "message": "string (1..8000 chars)",
  "pageContext": {
    "view": "string|null",
    "agentId": "uuid|null",
    "conversationId": "uuid|null"
  }
}
```

- `conversationId: null` creates a new copilot conversation.
- `pageContext` describes what the operator is viewing; `pageContext.conversationId`
  is a **customer** conversation id (History/Activity), unrelated to copilot
  conversation ids. `view` is a small enum the frontend sends from routing:
  `"activity" | "history" | "agent" | "documents" | "workbench" | "quality" | "evals" | "other"`.
- 409 if the copilot conversation already has a running turn.
- 503 with `{ "reason": "no_llm_capability" }` when availability is false.

## SSE events (`POST /turns` response)

`Content-Type: text/event-stream`. Each event is `event: <name>` +
`data: <json>`. Order: `conversation` first, then any mix of `activity` and
`chunk`, then exactly one `outcome`, then `done`.

| event | data | notes |
|---|---|---|
| `conversation` | `{ "conversationId": "uuid", "turnId": "uuid" }` | always first |
| `activity` | `{ "toolCallId": "string", "tool": "string", "stage": "started\|completed\|failed" }` | `tool` is a UI-safe label (e.g. `"Reading conversation trace"`), never raw payloads |
| `chunk` | `{ "text": "string" }` | answer text delta |
| `outcome` | `{ "status": "completed\|budget_exhausted\|failed" }` | exactly once |
| `done` | `{}` | terminal, always last |

Errors after the stream opened surface as `outcome: failed` + `done`, not as
broken streams. The full turn (message, activity, outcome) is persisted
server-side regardless of client disconnect.

## US1 read-tool families (backend-internal, listed for shared vocabulary)

Family readers, each with a UI-safe label used in `activity.tool`:

- agent discovery plus selected-agent configuration (via `AgentConfig`
  projection, including bounded directive summaries and an optional targeted
  directive whose metadata, collections, and total result have explicit bounds;
  the bounded projection also includes the platform's built-in answer
  directives so authored supersession/conflicts can be explained; explicit
  discovery can override page context; label "Reading agent configuration")
- bounded routine discovery with stable ids and portability metadata, plus a
  targeted portable-Markdown definition or explicit diagnostic/omission reason;
  label "Reading routine"
- customer conversation transcript + turn trace (trace envelope; label "Reading conversation trace")
- conversation history search (label "Searching conversations")
- document search + document metadata (label "Searching documents")

Permissions per spec 104 FR-006 matrix.
