---
title: "MCP Client Setup"
description: "Set up the standalone HTTP agent-converse MCP surface and its authentication flow."
last_updated: 2026-08-31
---

# MCP Client Setup

Radioso exposes an agent-converse MCP surface for clients that need to talk to one configured agent.

- **Agent converse surface**: an MCP client talks to one specific agent, with that agent's persona, directives, routines, history, and configured retrieval. It authenticates with a per-agent converse grant. Use this when the client should behave like the agent.
- **Workspace document work**: use the REST document routes with a personal token or service-account credential. MCP rejects those REST credentials.

An agent-converse grant is a per-agent MCP credential. Standalone `/mcp` accepts this grant and performs the exchange internally. Personal and service-account REST credentials do not authorize MCP. The backend's merged MCP route and workspace context route are unavailable in this release.

## Agent Converse Surface

The converse surface lets an external client hold a conversation with one agent. The client never sees other agents, workspace settings, or document management. It can do three things: ask the agent, request a grounded answer using the agent's retrieval settings, and read the agent's documents as resources.

A converse credential authorizes exactly one agent, and its reach ends there.

### Mint a converse grant

A converse grant is the per-agent credential a client uses. A workspace admin creates it through a signed-in dashboard session. The plaintext token is returned once, on creation. Store it as a secret.

```http
POST /api/v1/agents/{agentId}/mcp-converse-grants
Cookie: <signed-in dashboard session>
X-Workspace-Id: <workspace UUID>
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

### Use the grant with standalone MCP

For the standalone MCP server, send the original grant token as the bearer on `/mcp`. The standalone server exchanges it with the backend internally and keeps the resulting short-lived session in its runtime store. Do not send the backend session token to `/mcp`.

For direct REST calls to the converse API, a client can exchange the grant token for a short-lived session token. The session is bound to the agent.

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

Send that session token as a bearer token on the direct REST converse calls below. There is no agent id in the requests; the agent is fixed by the grant. To reconnect after the session expires, exchange the grant again.

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

- The converse surface accepts only converse grants. Personal tokens, service-account credentials, and removed shared workspace tokens are rejected.
- A converse grant is bound to the `mcp-converse` channel. Embed and public-chat launch tokens are rejected, so a public website token cannot be used to converse over MCP.
- A converse grant is a secret. Unlike an embed token, it is never exposed in client-side surfaces.

### Authentication limits

The converse surface uses the grant-for-session exchange described above. MCP authentication is based on the per-agent converse grant and its short-lived session. Personal and service-account REST credentials do not authorize MCP, and the package does not add an OAuth front door.

## Deployment Modes

Radioso supports standalone MCP. The backend can also report a configured merged route as unsupported:

- **Standalone**: run `packages/radioso-mcp-server` as a separate HTTP process. Give its `/mcp` endpoint the original agent-converse grant; it performs the exchange internally.
- **Merged configuration**: the backend reports `merged_auth_unavailable` and does not mount a usable `/mcp` route. Run standalone MCP for agent-converse clients.
- **Hybrid**: keep the backend's merged setting off and run the standalone process alongside the backend. Use `RADIOSO_MCP_REDIS_URL` when multiple standalone instances need shared session state.

Every controlled runtime store purges sessions containing retired upstream verifier material before MCP readiness. An unavailable configured store leaves the runtime unavailable while purge retries; it does not switch to an in-memory store.

## Cursor On Localhost

Cursor can connect to a standalone Radioso MCP server:

- **HTTP (URL mode)**: Cursor connects to `http://127.0.0.1:8787/mcp`. Point its MCP config at that URL and pass the original agent-converse grant in `RADIOSO_MCP_ACCESS_TOKEN`.
- **Merged mode**: the backend reports `merged_auth_unavailable`; use standalone mode instead.

### Same-Host Merged Mode

The backend's merged MCP route is unavailable because it has no eligible authentication class. Its health response reports `mode: "unsupported"` and `reason: "merged_auth_unavailable"`; configure a standalone HTTP MCP server for agent-converse access. If the backend has `RADIOSO_MCP_REDIS_URL` configured, health remains unready while its purge-only maintenance lifecycle retries and becomes ready after the purge succeeds.

### Standalone HTTP Mode

1. Start the Radioso backend and the remote MCP server.
2. Obtain an agent-converse grant from the signed-in dashboard and store the original grant in `RADIOSO_MCP_ACCESS_TOKEN`.
3. Configure Cursor to connect to `http://127.0.0.1:8787/mcp` with `Authorization: Bearer ${env:RADIOSO_MCP_ACCESS_TOKEN}`, then open this repo in Cursor. Standalone performs the grant exchange internally.
4. Ask Cursor to talk to the bound agent.

The standalone session expires according to its configured access-token lifetime. To reconnect, send the original agent-converse grant to `/mcp` again.

## Security Notes

The backend's same-host MCP setting is reported as unsupported in this release. Standalone mode provides the authenticated `/mcp` surface.

Standalone mode keeps a separate public surface. It is the better fit when cloud connectors need public HTTPS access but the main backend should remain private.

Agent-converse grants are secret bearer credentials bound to one agent. Public chat and website embed launch credentials are separate credential types and are not accepted by the converse MCP surface. Personal and service-account REST credentials do not authorize MCP.

## Endpoint Model

The standalone `/mcp` endpoint serves the agent-converse surface. `ask_agent` runs the bound agent's turn loop, `answer_grounded` uses that agent's retrieval settings, and MCP resources expose the agent's documents. The original converse grant fixes the agent and its authorization boundary; standalone performs the grant-to-session exchange.

Workspace retrieval and document operations remain REST surfaces. Personal and service-account REST credentials do not become MCP tool credentials.

Use `ask_agent` for a stateful conversation that follows the bound agent's persona, directives, and routines. Use `answer_grounded` for a one-shot, cited lookup against that agent's retrieval configuration. Agent document resources are read-only and expose only documents the bound agent can see.

For programmatic document ingestion or maintenance, call the REST API with an eligible REST credential. That keeps a content pipeline's write authority separate from an MCP client that is talking to an agent.

### macOS GUI Launches

If you normally open Cursor from the Dock, Spotlight, Raycast, or a desktop launcher, install the agent-converse bearer into the app environment with your platform's environment manager, then open a fresh Cursor instance.

If Cursor is already open, fully quit it first so the relaunched app picks up the new token.

## Claude And Claude Desktop Remote Connectors

Claude custom connectors are true remote connectors. Anthropic connects to your MCP server from Anthropic's cloud infrastructure, not from your laptop, so `http://127.0.0.1:8787/mcp` will not work there.

To use Radioso from Claude or Claude Desktop as a remote connector:

1. Deploy the MCP server to a public HTTPS URL such as `https://mcp.example.com/mcp`.
2. Configure the connector to send the original agent-converse grant as its bearer. Standalone performs the exchange internally.
3. In Claude, open `Customize -> Connectors` and add a custom connector with that remote URL.
4. The package does not provide OAuth onboarding for the connector.

Claude Desktop local stdio setup is not available in this release. Use the standalone HTTP server with a public HTTPS deployment for remote connectors.

### Anthropic Messages API

For direct API testing, Anthropic's Messages API can connect to a public remote MCP server and inject an agent-converse bearer per request.

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
      "authorization_token": "radioso_mcp_converse_..."
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
2. Supply the original agent-converse grant through the host's static bearer configuration. Standalone performs the exchange internally.
3. In ChatGPT workspace settings, enable developer mode and create a custom app from that MCP server URL.
4. The package does not provide OAuth onboarding or REST-credential tool access for the app.

### OpenAI Responses API

The Responses API can call a remote MCP server directly. A typical tool stanza looks like this:

```json
{
  "type": "mcp",
  "server_label": "radioso",
  "server_url": "https://mcp.example.com/mcp",
  "require_approval": "never"
}
```

`require_approval: "never"` skips the host-side prompt. The MCP surface in this feature is the agent-converse surface; the package does not add OAuth onboarding, REST-credential tool filtering, a skills catalogue, or Ray access.
