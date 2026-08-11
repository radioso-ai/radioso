---
title: "MCP Client Setup"
description: "Setup guide covering the agent converse surface, the workspace document tools, MCP deployment modes, and authentication flows."
last_updated: 2026-07-27
---

# MCP Client Setup

Radioso exposes two MCP surfaces. They serve different needs and use different credentials.

- **Agent converse surface**: an MCP client talks to one specific agent, with that agent's persona, directives, routines, history, and configured retrieval. It authenticates with a per-agent converse grant. Use this when the client should behave like the agent.
- **Workspace document tools**: retrieval-first tools (`search_documents`, `answer_grounded`, document read/write) scoped to a whole workspace. They authenticate with a workspace API token and do not use any agent's persona or configuration. The rest of this guide, from "Deployment Modes" onward, describes this surface.

The two surfaces do not share credentials. A converse grant is rejected by the workspace tools, and a workspace API token is rejected by the converse surface.

## Agent Converse Surface

The converse surface lets an external client hold a conversation with one agent. The client never sees other agents, workspace settings, or document management. It can do three things: ask the agent, request a grounded answer using the agent's retrieval settings, and read the agent's documents as resources.

A converse credential authorizes exactly one agent, and its reach ends there.

### Mint a converse grant

A converse grant is the per-agent credential a client uses. A workspace admin creates it with the workspace API token. The plaintext token is returned once, on creation. Store it as a secret.

```http
POST /api/v1/agents/{agentId}/mcp-converse-grants
Authorization: Bearer <workspace API token>
Content-Type: application/json

{ "label": "Cursor on my laptop" }
```

The response includes the token once:

```json
{
  "grant": { "id": "...", "label": "Cursor on my laptop", "tokenPrefix": "radioso_", "createdAt": "..." },
  "token": "radioso_..."
}
```

Manage existing grants with the same path:

- `GET /api/v1/agents/{agentId}/mcp-converse-grants` lists grant metadata. It never returns the token.
- `POST /api/v1/agents/{agentId}/mcp-converse-grants/{grantId}/rotate` issues a new token and invalidates the old one.
- `DELETE /api/v1/agents/{agentId}/mcp-converse-grants/{grantId}` revokes the grant.

Grant changes take effect on the next request. Revoking, disabling, or rotating a grant stops its existing sessions, because every converse request re-checks the grant.

### Exchange the grant for a session

A client exchanges the grant token for a short-lived session token. The session is bound to the agent.

```http
POST /api/v1/mcp/converse/session
Content-Type: application/json

{ "launchToken": "radioso_...", "client": { "name": "cursor" } }
```

```json
{
  "sessionToken": "<session token>",
  "expiresAt": "...",
  "agent": { "id": "...", "name": "Support" },
  "conversationId": "..."
}
```

Send the session token as a bearer token on the converse calls below. There is no agent id in the requests; the agent is fixed by the grant. To reconnect after the session expires, exchange the grant again.

### Converse calls

Ask the agent. This runs the agent's full turn loop, so the reply reflects its persona, directives, and routines, and continues the same conversation across calls.

```http
POST /api/v1/mcp/converse/ask
Authorization: Bearer <session token>

{ "message": "What is your refund window?" }
```

If another ask arrives for the same conversation before the first reply starts,
the first request returns HTTP `409` with error code `chat_turn_superseded`. The
newer ask waits for cleanup and answers from the latest conversation history. If
the first reply has already started persisting, it completes before the newer ask
runs.

This behavior also applies when concurrent requests are the session's first asks.
The session atomically binds them to one conversation before processing, so
clients do not need to serialize the first ask.

Request a grounded answer. This uses the bound agent's retrieval settings (query rewrite, rerank, source scope, citation policy), so the result matches the agent's in-product answers rather than workspace defaults.

```http
POST /api/v1/mcp/converse/grounded-answer
Authorization: Bearer <session token>

{ "query": "refund window" }
```

Read the agent's documents as MCP resources. The list is scoped to what the agent can see, and content is sanitized for a public surface (no internal document or chunk ids).

```http
GET /api/v1/mcp/converse/resources
GET /api/v1/mcp/converse/resources/{resourceId}
Authorization: Bearer <session token>
```

### Authentication boundaries

- The converse surface accepts only converse grants. A workspace API token is rejected.
- A converse grant is bound to the `mcp-converse` channel. Embed and public-chat launch tokens are rejected, so a public website token cannot be used to converse over MCP.
- A converse grant is a secret. Unlike an embed token, it is never exposed in client-side surfaces.

### Authentication limits

The converse surface uses the grant-for-session exchange described above. This fits self-hosted setups and applications that hold the grant on a server. There is no standard MCP OAuth 2.1 front door for public connectors such as Claude or ChatGPT; public connectors authenticate with a session token minted through the exchange flow.

## Deployment Modes

Radioso supports three MCP deployment modes:

- **Same-host backend MCP**: set `RADIOSO_MCP_ENABLED=true` and leave `RADIOSO_MCP_STANDALONE=false`. The backend serves MCP at `RADIOSO_MCP_MOUNT_PATH` (default `/mcp`). Clients use the workspace API token directly as the bearer token.
- **Standalone-only**: run `packages/radioso-mcp-server` as a separate HTTP process. Clients first exchange a workspace API token for a short-lived MCP access token.
- **Hybrid**: enable merged mode on the backend and also run a standalone MCP server for public connector traffic. Use `RADIOSO_MCP_REDIS_URL` on both when approval and session state must be shared.

Use merged mode for simple self-hosted installs where the backend and MCP endpoint have the same exposure. Use standalone mode when MCP is public but the main backend should stay internal or behind a different network policy.

## Cursor On Localhost

Cursor can connect to Radioso in two ways:

- **Same-host merged mode**: Cursor connects to the backend MCP route, such as `http://localhost:8080/mcp`, and sends `Authorization: Bearer <workspace API token>`.
- **Remote HTTP (URL mode)**: Cursor connects to a local HTTP MCP server at `http://127.0.0.1:8787/mcp`. Point your local Cursor MCP config at that URL and pass a short-lived bearer token in `RADIOSO_MCP_ACCESS_TOKEN`.
- **Local stdio (stdio mode)**: Cursor launches the MCP server process itself (no separate HTTP daemon). This uses `RADIOSO_BASE_URL` and `RADIOSO_API_TOKEN` directly.

### Same-Host Merged Mode

1. Start the backend with `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false`.
2. Configure Cursor to connect to `http://localhost:8080/mcp`, or your deployed backend origin plus `/mcp`.
3. Use the workspace API token directly in `Authorization: Bearer <workspace API token>`.
4. Ask Cursor to list tools or query workspace documents.

No `/v1/auth/exchange` call is needed in merged mode.

### Standalone HTTP Mode

1. Start the Radioso backend and the remote MCP server.
2. Exchange a Radioso workspace API token for an MCP access token:

```bash
source <(
  RADIOSO_WORKSPACE_TOKEN=radioso_example \
  pnpm --dir packages/radioso-mcp-server run -s token:exchange
)
```

3. Configure Cursor to connect to `http://127.0.0.1:8787/mcp` with `Authorization: Bearer ${env:RADIOSO_MCP_ACCESS_TOKEN}`, then open this repo in Cursor.
4. Ask Cursor to list tools or query workspace documents.

The exchange helper emits a short-lived token. Rerun it when the MCP session expires.

## Security Notes

Same-host backend MCP exposes MCP anywhere the backend is reachable. This is convenient for self-hosted installs, but it means public backend deployments also expose `/mcp` unless you restrict it at the reverse proxy or keep `RADIOSO_MCP_ENABLED=false`.

Standalone mode keeps a separate public surface. It is the better fit when cloud connectors need public HTTPS access but the main backend should remain private.

The merged route has separate CORS configuration through `RADIOSO_MCP_MERGED_CORS_ORIGINS`. The default is `*` without credentials, because MCP clients use bearer tokens rather than dashboard cookies.

Workspace API tokens are secret bearer credentials bound to one workspace. Public chat and website embed launch credentials are not API tokens and are never accepted by MCP or other workspace API bearer-authenticated routes.

## Endpoint Model

MCP is retrieval-first by default. Tools such as `search_documents` and `answer_grounded` call Radioso retrieval and document endpoints directly. They do not create assistant conversations and they do not inherit assistant persona, greeting, or social-reply behavior.

In practice:

- Use MCP `answer_grounded` when a client wants a grounded answer from workspace documents.
- Use MCP document tools when a client wants document capability access.
- Use `POST /api/v1/assistant/chat` only when the integration explicitly wants the customer-facing assistant chat product.

The retrieval answer endpoint accepts optional `conversationContext` hints for rewrite continuity. The caller owns those hints. Radioso retrieval uses them to improve the search query, but retrieval does not become the owner of assistant chat history.

Direct REST and SDK clients receive retrieval diagnostics only on request. Set `includeDebug: true` and read `debug.activitySummary`, `debug.activityTrace`, and, for grounded answers, `debug.evidence`. The MCP server opts into debug responses for retrieval tools by default, so operators can inspect grounded-answer traces from MCP clients.

For debugging, MCP grounded-answer calls request diagnostic metadata from the retrieval API and are marked as `mcp_capability` executions. This keeps them separate from direct retrieval API calls and assistant-backed chat turns.

Grounded-answer diagnostics also include retrieval shape metadata in `debug.activityTrace` and `debug.activitySummary`. Look for the `shape_selection` stage and summary fields such as `shapeName`, `queryShape`, `resolvedSteps`, and `skillDiagnostic`. These fields explain which resolved retrieval shape and step overrides were applied.

## Reprocess Documents

The workspace document tools include `reprocess_document`. It requeues an existing document through the backend document processing path.

The tool accepts an optional `documentEnrichmentOverride` argument:

```json
{
  "documentId": "document-id",
  "documentEnrichmentOverride": "on"
}
```

Values are `on` and `off`. The override applies only to the processing job created by this tool call. It does not change the workspace ingestion setting or the source-level enrichment override.

## Skills Catalog

Radioso also exposes a read-only skills catalog through the main API:

```http
GET /api/v1/skills
GET /api/v1/skills/{skillName}
```

MCP clients can use the catalog to understand the shared skill vocabulary without changing how tools execute. For example, `retrieval.answer` points to the retrieval answer API and the MCP `answer_grounded` tool, while `mcp.describe_capabilities` points to the MCP capability discovery tool.

The catalog does not force MCP traffic through assistant chat. MCP tools remain retrieval-first and document-capability-oriented unless an integration explicitly chooses the assistant chat API.

### macOS GUI Launches

If you normally open Cursor from the Dock, Spotlight, Raycast, or a desktop launcher, use the macOS helper instead:

```bash
RADIOSO_WORKSPACE_TOKEN=radioso_example \
pnpm --dir packages/radioso-mcp-server run -s cursor:prepare -- --open
```

That exchanges the token, installs `RADIOSO_MCP_ACCESS_TOKEN` into the macOS GUI app environment with `launchctl`, and opens a fresh Cursor instance for this repo.

If Cursor is already open, fully quit it first so the relaunched app picks up the new token.

### Cursor With Stdio (No Local HTTP Server)

If you prefer Cursor to spawn the MCP server directly:

- Set `RADIOSO_BASE_URL` (for example `http://localhost:8080`)
- Set `RADIOSO_API_TOKEN` (your workspace API token, `radioso_...`)
- Ensure `pnpm install --filter @radioso/mcp-server...` has been run so the `cursor:mcp-stdio` entrypoint can run.

## Claude And Claude Desktop Remote Connectors

Claude custom connectors are true remote connectors. Anthropic connects to your MCP server from Anthropic's cloud infrastructure, not from your laptop, so `http://127.0.0.1:8787/mcp` will not work there.

To use Radioso from Claude or Claude Desktop as a remote connector:

1. Deploy the MCP server to a public HTTPS URL such as `https://mcp.example.com/mcp`.
2. Add connector-compatible authentication in front of that public deployment. The package ships its own `/v1/auth/exchange` flow, which works for local and API-driven clients but is not a native Claude connector auth flow.
3. In Claude, open `Customize -> Connectors` and add a custom connector with that remote URL.
4. If your hosted server uses OAuth, provide the client ID and client secret in Claude's advanced settings.
5. Authenticate the connector, then enable it in a conversation.

If you want localhost-only Claude Desktop access, use the stdio compatibility entrypoint instead of the remote connector flow.

### Anthropic Messages API

For direct API testing, Anthropic's Messages API can connect to a public remote MCP server and inject a bearer token per request. That makes the current Radioso auth flow usable for ad hoc API calls once you mint a short-lived access token first.

```json
{
  "model": "claude-opus-4-6",
  "max_tokens": 1000,
  "messages": [
    {
      "role": "user",
      "content": "List the tools available from Radioso."
    }
  ],
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://mcp.example.com/mcp",
      "name": "radioso",
      "authorization_token": "mcp_sess_..."
    }
  ],
  "tools": [
    {
      "type": "mcp_toolset",
      "mcp_server_name": "radioso"
    }
  ]
}
```

## ChatGPT Apps And Responses API

ChatGPT custom apps and OpenAI API integrations also require a public remote MCP server. OpenAI does not support connecting ChatGPT to a local MCP server.

### ChatGPT App

1. Deploy the MCP server to a public HTTPS URL.
2. Add app-compatible authentication. In practice that means OAuth or OpenID Connect with refresh-token support. The package's `/v1/auth/exchange` flow is not enough for native ChatGPT app onboarding by itself.
3. In ChatGPT workspace settings, enable developer mode and create a custom app from that MCP server URL.
4. If your deployment uses OAuth or OpenID Connect, configure refresh-token-capable auth before publishing.
5. Connect the app in ChatGPT and test read and write paths. ChatGPT will prompt the user before any tool advertised with `requiresApproval: true`; that is the host-side approval gate for writes.

### OpenAI Responses API

The Responses API can call a remote MCP server directly. A typical tool stanza looks like this:

```json
{
  "type": "mcp",
  "server_label": "radioso",
  "server_url": "https://mcp.example.com/mcp",
  "allowed_tools": [
    "describe_capabilities",
    "list_documents",
    "get_document",
    "search_documents",
    "answer_grounded"
  ],
  "require_approval": "never"
}
```

`require_approval: "never"` skips the host-side prompt. The Radioso MCP server has no server-side approval gate — authorization is the workspace API token and the tools the MCP session was granted at exchange time, with the underlying workspace permission enforced at the upstream Radioso REST API. If you want a human-in-the-loop step for writes, run the integration through a host that honors the per-tool `requiresApproval: true` advertisement (such as Cursor, Claude Desktop, or the ChatGPT app UI) instead of through the headless Responses API. If your hosted Radioso MCP endpoint is not public and unauthenticated, you will also need an OpenAI-compatible auth layer before this can be used from ChatGPT apps or OpenAI-hosted flows.
