---
title: "MCP Client Setup"
description: "Connect an MCP client either to one Radioso agent or to Ray's governed operator tools."
last_updated: 2026-09-04
---

# MCP Client Setup

Radioso exposes an MCP surface for clients that need to talk to one configured agent. It publishes one tool, `ask_agent`, which runs the same persona, directives, routines, and retrieval behavior as the agent's other chat channels.

For Ray's workspace-level read, probe, and proposal tools, use the separate [Operator MCP OAuth flow](./operator-mcp.md) under **Settings → API access**. Its `/operator/mcp` resource uses browser consent and never accepts an agent-channel credential.

- **Agent chat over MCP** uses a role-free MCP credential bound to exactly one agent.
- **Workspace document work** uses the REST document routes with a personal token or service-account credential.

Standalone `/mcp` accepts the agent's MCP credential and performs the short-lived session exchange internally. A personal token, service-account credential, REST-audience agent credential, public-chat token, or embed token cannot be used in its place.

## Agent Converse Surface

The converse surface lets an external client hold a conversation with one agent. The client never sees other agents, workspace settings, document-management APIs, Ray, or the skill catalogue. Retrieval can still participate inside `ask_agent` when the bound agent's configuration calls for it.

An MCP-audience agent credential authorizes exactly one agent, and its reach ends there.

### Mint an MCP credential

Open the agent's **Channels → MCP** card and create a credential with a label and expiry. Any signed-in user with permission to manage that agent can do this; the credential itself carries no workspace role. The plaintext secret is returned once and only its hash is retained, so store it before leaving the result.

```http
POST /api/v1/agents/{agentId}/channel-credentials
Cookie: <signed-in dashboard session>
X-Radioso-CSRF: 1
X-Workspace-Id: <workspace UUID>
Content-Type: application/json

{
  "audience": "mcp",
  "label": "Cursor on my laptop",
  "expiresAt": "<future ISO-8601 timestamp>"
}
```

The response includes the secret once:

```json
{
  "credential": {
    "id": "...",
    "audience": "mcp",
    "label": "Cursor on my laptop",
    "prefix": "radioso_...",
    "status": "active",
    "expiresAt": "..."
  },
  "secret": "radioso_..."
}
```

Manage existing credentials with the same path:

- `GET /api/v1/agents/{agentId}/channel-credentials?audience=mcp` lists safe metadata. It never returns a secret.
- `POST /api/v1/agents/{agentId}/channel-credentials/{credentialId}/rotate` issues a new secret and invalidates the old one.
- `POST /api/v1/agents/{agentId}/channel-credentials/{credentialId}/revoke` revokes the credential.

Credential changes take effect on the next request. Revoking, expiring, or rotating a credential stops its existing sessions, because every converse request re-checks the credential.

### Use the credential with standalone MCP

For the standalone MCP server, send the original credential secret as the bearer on `/mcp`. The standalone server exchanges it with the backend internally and keeps the resulting short-lived session in its runtime store. Do not send the backend session token to `/mcp`.

For direct calls to the internal converse API, a client can exchange the MCP credential for a short-lived session token. The session remains bound to the agent.

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

Send that session token as a bearer token on the direct converse call below. There is no agent id in the request; the agent is fixed by the credential. To reconnect after the session expires, exchange the credential again.

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

### Authentication boundaries

- The converse surface accepts only MCP-audience agent credentials and sessions created from them.
- Each credential is bound to the `mcp` audience and exactly one agent. A credential issued with the `rest` audience is rejected even when it belongs to the same agent.
- The plaintext credential is shown once. Inventory and detail responses expose only a safe prefix and lifecycle metadata.

### Authentication limits

The converse surface uses the agent credential-for-session exchange described above. Agent MCP credentials are static bearer secrets. Personal and service-account credentials do not authorize this surface.

The exchange is rate limited before credential lookup. A source bucket runs first, followed by a bucket keyed by a one-way launch-token digest; this bounds durable work when a caller sends many different invalid tokens. Rejected and unavailable checks are counted in a low-cardinality metric. Individual pre-auth failures are not written as audit events because an invalid-token flood must not turn into an unbounded audit-write workload.

## Deployment

Run `packages/radioso-mcp-server` as a separate HTTP process. Give its `/mcp` endpoint the original MCP credential; it performs the exchange internally. Each process may cache short-lived backend session tokens in memory. Redis is optional when you want that cache shared across standalone instances.

For a Terraform-managed Cloud Run deployment, set `radioso_mcp_enabled = true`. Terraform starts a separate public MCP service from the production backend image and publishes its `/mcp` endpoint as the `mcp_url` output; the dashboard reads that address at runtime. Terraform also shares a generated `RADIOSO_MCP_SIGNING_SECRET` between MCP and the backend and sets `RADIOSO_TRUSTED_PROXY_HOPS=2`, matching Google's appended client/load-balancer suffix. Earlier caller-supplied forwarding values cannot choose the source budget. For manual deployments, keep the hop count at `0` unless you control the exact rightmost proxy chain.

The service shares the deployment's `backend_max_instances` cap, so malformed public requests cannot pin the only MCP process. Cloud Run may scale the MCP process to zero. On its next request, the client presents the original credential again, the process exchanges it again, and the backend resumes the conversation mapped to that credential's current version in PostgreSQL. Rotating the credential starts a separate conversation. A Redis-backed cache uses the signing secret to encrypt stored backend session tokens.

Before a Redis-backed runtime serves traffic, it removes historical session records carrying former upstream API-token fields. An unavailable configured store leaves the runtime unavailable while the purge retries.

## Cursor On Localhost

Cursor can connect to a standalone Radioso MCP server:

- **HTTP (URL mode)**: Cursor connects to `http://127.0.0.1:8787/mcp`. Point its MCP config at that URL and pass the original MCP credential in `RADIOSO_MCP_ACCESS_TOKEN`.

### Standalone HTTP Mode

1. Start the Radioso backend and the remote MCP server.
2. Create an MCP credential from the agent's **Channels → MCP** card and store its secret in `RADIOSO_MCP_ACCESS_TOKEN`.
3. Configure Cursor to connect to `http://127.0.0.1:8787/mcp` with `Authorization: Bearer ${env:RADIOSO_MCP_ACCESS_TOKEN}`, then open this repo in Cursor. Standalone performs the credential exchange internally.
4. Ask Cursor to talk to the bound agent.

To reconnect after a session expires, send the original MCP credential to `/mcp` again.

## Security Notes

Standalone mode keeps a separate public surface. In Terraform-managed Cloud Run, backend public invocation remains enabled so that service can call the agent-converse API.

MCP credentials are secret bearers bound to one agent. Public chat and website embed launch credentials are separate credential types and are not accepted by the converse MCP surface. Personal, service-account, and REST-audience agent credentials do not authorize MCP.

## Endpoint Model

The standalone `/mcp` endpoint serves the agent-converse surface. `ask_agent` runs the bound agent's turn loop. The original MCP credential fixes the agent and its authorization boundary; standalone performs the credential-to-session exchange.

Workspace retrieval and document operations remain REST surfaces. Personal and service-account REST credentials do not become MCP tool credentials.

Use `ask_agent` for a stateful conversation that follows the bound agent's persona, directives, routines, and retrieval configuration. Use the REST retrieval endpoints when an integration needs direct search or a one-shot grounded answer rather than a conversational turn.

For programmatic document ingestion or maintenance, call the REST API with an eligible REST credential. That keeps a content pipeline's write authority separate from an MCP client that is talking to an agent.

### macOS GUI Launches

If you normally open Cursor from the Dock, Spotlight, Raycast, or a desktop launcher, install the MCP bearer into the app environment with your platform's environment manager, then open a fresh Cursor instance.

If Cursor is already open, fully quit it first so the relaunched app picks up the new token.

## Claude And Claude Desktop Remote Connectors

Claude custom connectors are true remote connectors. Anthropic connects to your MCP server from Anthropic's cloud infrastructure, not from your laptop, so `http://127.0.0.1:8787/mcp` will not work there.

To use Radioso from Claude or Claude Desktop as a remote connector:

1. Deploy the MCP server to a public HTTPS URL such as `https://mcp.example.com/mcp`.
2. Configure the connector to send the original MCP credential as its bearer. Standalone performs the exchange internally.
3. In Claude, open `Customize -> Connectors` and add a custom connector with that remote URL.
4. The package accepts the operator-minted bearer directly; Radioso does not require OAuth onboarding for it.

Claude Desktop local stdio setup is not available in this release. Use the standalone HTTP server with a public HTTPS deployment for remote connectors.

### Anthropic Messages API

For direct API testing, Anthropic's Messages API can connect to a public remote MCP server and inject the MCP bearer per request.

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
      "authorization_token": "radioso_..."
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
2. Supply the original MCP credential through the host's static bearer configuration. Standalone performs the exchange internally.
3. In ChatGPT workspace settings, enable developer mode and create a custom app from that MCP server URL.
4. The package accepts the operator-minted bearer directly; Radioso does not require OAuth onboarding for it.

### OpenAI Responses API

The Responses API can call a remote MCP server directly. A typical tool stanza looks like this:

```javascript
const response = await client.responses.create({
  model: "gpt-5",
  input: "What is our refund window?",
  tools: [{
    type: "mcp",
    server_label: "radioso",
    server_url: "https://mcp.example.com/mcp",
    authorization: process.env.RADIOSO_MCP_ACCESS_TOKEN,
    require_approval: "never"
  }]
});
```

`authorization` is the Responses API MCP tool's bearer credential field. Read the value from your secret manager (the example uses `RADIOSO_MCP_ACCESS_TOKEN`); do not commit the credential to source.

`require_approval: "never"` skips the host-side prompt. The MCP surface contains `ask_agent`; it does not expose Ray or a skill catalogue.
