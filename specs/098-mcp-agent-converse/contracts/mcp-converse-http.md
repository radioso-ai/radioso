# Contract Notes: MCP Converse HTTP and MCP Surface

These are design-time contract notes. Runtime backend HTTP contracts must be registered in `backend/src/app/http/openapi/document.ts` using Zod-backed route schemas; `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.

## Auth Lanes

- Launch-token exchange uses an `mcp-converse` access-grant token, not `Authorization: Bearer`.
- Subsequent converse HTTP requests use the signed converse session.
- Workspace API bearer tokens are rejected on all public converse endpoints.
- Embed/public-link launch tokens are rejected by `resolveConverseGrant`.

## Backend HTTP Endpoints

### `POST /api/v1/mcp/converse/session`

Exchange an MCP converse launch token for a signed converse session.

Request:
```json
{
  "launchToken": "radioso_launch_secret",
  "client": {
    "name": "Cursor",
    "version": "optional"
  }
}
```

Response `201`:
```json
{
  "sessionToken": "signed-session",
  "expiresAt": "2026-06-27T12:00:00.000Z",
  "resumeToken": "optional-resume-token",
  "agent": {
    "id": "agent-id",
    "name": "Claudio"
  },
  "conversationId": "public-session-id"
}
```

Errors:
- `401 invalid_converse_grant`
- `403 grant_channel_not_allowed`
- `403 agent_unavailable`
- `429 rate_limited`

### `POST /api/v1/mcp/converse/session/validate`

Validate a signed session and re-evaluate the live grant. Used by standalone MCP per request when it needs a lightweight validation before exposing tools/resources.

Request:
```json
{
  "sessionToken": "signed-session"
}
```

Response `200`:
```json
{
  "valid": true,
  "workspaceId": "workspace-id",
  "agentId": "agent-id",
  "conversationId": "public-session-id",
  "permissions": [
    "public_chat.turn.create",
    "public_chat.session.read.own",
    "public_chat.history.read.own",
    "public_chat.feedback.write.own",
    "public_chat.retrieval.query",
    "public_chat.documents.read.scoped"
  ]
}
```

Errors:
- `401 invalid_session`
- `401 expired_session`
- `403 grant_revoked`
- `403 grant_rotated`
- `403 grant_channel_not_allowed`

### `POST /api/v1/mcp/converse/ask`

Run one `ask_agent` turn through the bound agent's turn loop.

Headers:
- `Authorization: Bearer <converse-session-token>` or an equivalent internal session header selected during implementation. Workspace API tokens must be rejected.

Request:
```json
{
  "message": "What should I do next?",
  "stream": false
}
```

Response `200`:
```json
{
  "conversationId": "public-session-id",
  "answer": {
    "text": "LLM generated answer",
    "citations": []
  },
  "traceId": "safe-correlation-id"
}
```

Rules:
- No `agentId` parameter.
- Uses sourceChannel `mcp`.
- Revalidates grant before the turn.
- Returns citations according to agent policy.

### `POST /api/v1/mcp/converse/grounded-answer`

Run an agent-aware grounded answer outside a full conversational turn.

Request:
```json
{
  "query": "Which policy applies?",
  "maxResults": 8
}
```

Response `200`:
```json
{
  "answer": "LLM generated grounded answer",
  "citations": [],
  "retrieval": {
    "agentScoped": true
  }
}
```

Rules:
- Requires `public_chat.retrieval.query`.
- Uses bound agent retrieval configuration, not system defaults.
- Does not expose internal chunk ids unless allowed by citation policy.

### `GET /api/v1/mcp/converse/resources`

List sanitized read-only resources visible to the bound agent.

Response `200`:
```json
{
  "resources": [
    {
      "uri": "radioso://agent-resource/opaque-id",
      "name": "Onboarding policy",
      "mimeType": "text/markdown"
    }
  ]
}
```

### `GET /api/v1/mcp/converse/resources/{resourceId}`

Read one sanitized resource visible to the bound agent.

Response `200`:
```json
{
  "uri": "radioso://agent-resource/opaque-id",
  "mimeType": "text/markdown",
  "text": "sanitized content"
}
```

Rules:
- Requires `public_chat.documents.read.scoped`.
- Resource identifiers are opaque and session/agent scoped.
- No document management behavior.

## OAuth 2.1 Front Door (US4)

Endpoints are backend-owned and issue the same session authority as launch-token exchange:

- `GET /.well-known/oauth-protected-resource` or chosen MCP protected-resource metadata path.
- `POST /api/v1/mcp/oauth/register` for dynamic client registration.
- `GET /api/v1/mcp/oauth/authorize` for PKCE authorization code.
- `POST /api/v1/mcp/oauth/token` for code and refresh exchange.

Rules:
- PKCE required.
- Refresh revalidates the underlying grant.
- OAuth client metadata is principal-agnostic so future Scope 2 can reuse transport substrate without expanding this converse contract.

## MCP Tool and Resource Surface

Active Scope 1 tools/resources:

- `ask_agent`: US1; calls `/api/v1/mcp/converse/ask`.
- `answer_grounded`: US2; calls `/api/v1/mcp/converse/grounded-answer` and is agent-aware.
- MCP resources: US2; list/read via backend resource endpoints.

Denied on public converse path:

- `list_documents`
- `get_document`
- `search_documents`
- `create_document`
- `update_document`
- `delete_document`
- `reprocess_document`
- Workspace settings/admin tools
- Agent create/update/directive/routine/eval tools

Legacy workspace-token MCP remains only for trusted local/stdio/self-host mode and must not be reachable on the public converse path.

## Message-Queue Impact

Expected impact: none.

- Document worker dispatch: unchanged.
- AMQP payloads: unchanged.
- Retry semantics: unchanged.
- Queue docs/tests: update only if implementation discovery finds a queue touchpoint.

Implementation must still include an explicit review task and record the conclusion in PR notes.
