---
title: "MCP Client Setup"
description: "Connect an MCP client either to one Radioso agent or to Ray's governed operator tools."
last_updated: 2026-09-22
---

# MCP Client Setup

Radioso exposes an MCP surface for clients that need to talk to one configured agent. Its `ask_agent` tool runs the same persona, directives, routines, and retrieval behavior as the agent's other chat channels, and every routine the operator has exposed on the agent is listed beside it as a typed tool of its own.

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

### The agent's public id

A credential is how a client you approved reaches the agent. A **public id** is how anything else identifies it. The same **Channels → MCP** card carries an **Open access** block with two switches and the id they mint:

- **Publish the agent card** describes the agent to whoever asks: what it does, what it can run, and where its MCP endpoint is.
- **Allow connecting without a credential** lets any AI agent holding the public id start a conversation. It needs the card published, because the card is what tells a caller how to connect.

Turning on either switch mints the id, once, and the card shows it:

```
ag_7Qb3nT1xK9wZs2Pv0Lm4Rd
```

Treat it as an address rather than a secret. It is meant to appear in a page, a card, or a support email, and holding it grants nothing on its own — with **Allow connecting without a credential** off, a caller with the id still needs a credential. The id is separate from the embed token for exactly this reason: the embed token *is* a secret, and it sits in the page HTML.

Alongside the switches, **Description** is the one line a calling agent reads before deciding to ask — write what the agent helps with, in the visitor's terms. **New conversations per hour** caps what one looping caller can spend from the workspace's conversation allowance; leave it empty to use the deployment's own budget.

Rotating replaces the id:

```http
POST /api/v1/agents/{agentId}/public-id/rotate
Cookie: <signed-in dashboard session>
X-Radioso-CSRF: 1
X-Workspace-Id: <workspace UUID>
```

Rotation is a revocation. Every agent connected without a credential is dropped on its next request, and anything published carrying the old id stops resolving, so rotate when an id needs to stop working — not as routine hygiene. Credential-bound clients are unaffected; rotating their credentials is a separate action on the same card. The rotation is recorded as an `agent.public_id.rotated` audit event, and changes to the two switches as `agent.public_access.changed`; neither event records the id itself.

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

The reply is an **agent reply envelope**: the answer text plus the facts a calling agent needs to decide what to do next. Whether the answer is grounded, whether a person has taken the conversation over, and what a running routine still needs are all fields, so a client does not have to guess from prose.

```json
{
  "conversationId": "5f3c…",
  "answer": {
    "text": "You can return an order within 30 days of delivery.",
    "citations": [
      { "documentId": "a1…", "chunkId": "b2…", "title": "Refund policy", "sourceUrl": "https://example.com/refunds" }
    ]
  },
  "answerCoverage": {
    "availability": "assessed",
    "coverage": "answered",
    "reason": "sufficient_evidence",
    "originatingTurnId": "c3…",
    "originatingRequestId": "c3…"
  },
  "ownership": { "state": "ai_owned", "suppressed": false },
  "traceId": "d4…"
}
```

Read it field by field:

- `answerCoverage` is the same coverage verdict the dashboard trace shows for the turn. `coverage` is `answered`, `partial`, `unanswered`, or `unclear`, and `reason` says why; `intentional_scope_boundary` with `unanswered` means the agent declined on purpose. When no assessment ran for the turn (a direct reply, a routine step), `availability` is `not_recorded` and the verdict fields are absent.
- `ownership` tells you who owns the conversation after this turn. `{ "state": "human_owned", "suppressed": true }` means a person has taken over and the agent generated nothing; keep the session and [come back for the reply](#come-back-after-a-handoff).
- `routine` appears when the turn touched a routine: the one it ran, or the one that kept the turn while it waits for an operator's approval. `status` is one of `active`, `waiting_for_input`, `waiting_for_approval`, `completed`, or `abandoned`, and `pendingInput` lists every required slot the routine still needs plus the current step's optional ones, each with its `key`, `type` (`text`, `number`, `boolean`, `email`, `date`), `required` flag, and `description` — so you can supply all of them in one follow-up message.
- `invocation` appears only when you called a routine tool (next section) and says what became of the call: `toolName` and an `outcome` of `started`, `reentered`, `declined`, `not_started`, or `unknown_tool`.
- `traceId` is the turn's trace id, the one an operator sees in Activity; quote it when you report a problem.

The standalone MCP server forwards this envelope unchanged as the `ask_agent` tool's `structuredContent`; the tool's text content is `answer.text` followed by a blank line and the same envelope as pretty-printed JSON, so a client that only reads text still sees every field. The REST agent channel (`POST /api/v1/agents/{agentId}/chat`) returns the same `answerCoverage`, `ownership`, `routine`, `invocation`, and `traceId` fields beside its own `answer` string and `citations` array, and its SSE `done` frame carries them too.

### Come back after a handoff

A calling agent cannot sit in a chat window waiting for a person to answer. When `ownership.state` turns `human_owned`, read the conversation back instead:

```http
GET /api/v1/mcp/converse/messages?cursor=eyJ2ZXJza…&waitMs=25000
Authorization: Bearer <session token>
```

```json
{
  "messages": [
    { "id": "9a…", "author": "human", "createdAt": "2026-09-22T10:14:02.117Z", "text": "I have refunded the order." }
  ],
  "cursor": "eyJ2ZXJza…",
  "ownership": { "state": "human_owned" }
}
```

- `author` is `human` for an operator's reply and `agent` for everything else. An operator's message is stored as an assistant message, so the author kind is the only thing that tells a person's turn from the agent's.
- `cursor` is opaque. Send back the one the previous reply gave you; the response's `cursor` is where to resume next time. Called with no cursor, the route returns the conversation's most recent page, so a client that has lost its place can pick the conversation up again.
- `ownership` is the conversation's state alone, `ai_owned` or `human_owned`. The `suppressed` flag on an `ask_agent` reply says whether the agent generated anything on that turn; a read runs no turn, so it carries no such flag.
- `waitMs` (0–25000) holds the request open until a message lands. At the deadline the route answers `200` with an empty `messages` list — nothing new yet, not a failure — so a client loops on the same cursor. The wait is raced against a short re-query, so a reply written by another API instance still wakes the call.
- One call spends one unit of the read budget no matter how long it waits: 60 a minute per session, and 60 a minute per calling source. The per-source number is also what bounds how many reads one source can have parked at once — at 60 a minute against a 25-second ceiling, about 25 of them overlap.

Over standalone MCP this is the `get_conversation_updates` tool, taking the same `cursor` and `waitMs`. The session's conversation is keyed by the `Mcp-Session-Id` header the server returns on first contact: echo it on every later request to stay in the same conversation. A client that drops the header gets a fresh conversation on each call, so the reply it is waiting for never arrives.

### Routines as tools

An operator can expose a routine as a named tool (see [Authoring Routines](./authoring-routines.md#expose-a-routine-as-a-tool)). Read the catalog to see what the agent can do beyond answering:

```http
GET /api/v1/mcp/converse/tools
Authorization: Bearer <session token>
```

```json
{
  "agent": { "name": "Acme Support", "description": null },
  "tools": [
    {
      "toolName": "start_return",
      "description": "Start a return for an order the customer already has.",
      "routineLineageId": "7c1e…",
      "inputSchema": {
        "type": "object",
        "properties": {
          "orderId": { "type": "string", "description": "The order number on the confirmation email." },
          "reason": { "type": "string", "description": "Why the order is coming back." }
        },
        "required": ["orderId"],
        "additionalProperties": false
      }
    }
  ]
}
```

Each descriptor's `inputSchema` is JSON Schema built from the routine's declared slots: `text` becomes `string`, `number` and `boolean` keep their types, `email` is `string` with `format: "email"`, `date` is `string` with `format: "date"` (an ISO calendar day such as `2026-09-01`), and `required` follows the slot. A routine with no slots is a tool with an empty object schema.

Call a tool by sending `routine` instead of `message` on the same ask route. The routine starts at once with those slots filled, skips the steps that would have asked for them, and then behaves exactly as it would for a person: confirmation steps, approvals, and handoff all apply.

```http
POST /api/v1/mcp/converse/ask
Authorization: Bearer <session token>

{ "routine": { "toolName": "start_return", "input": { "orderId": "A-1001" } } }
```

The reply is the same envelope, and `routine` tells you where the call landed:

```json
{
  "conversationId": "5f3c…",
  "answer": { "text": "Got it — order A-1001. Why is it coming back?", "citations": [] },
  "answerCoverage": { "availability": "not_recorded", "originatingTurnId": "c3…", "originatingRequestId": "c3…" },
  "ownership": { "state": "ai_owned", "suppressed": false },
  "routine": {
    "toolName": "start_return",
    "name": "Start a return",
    "status": "waiting_for_input",
    "pendingInput": [
      { "key": "reason", "type": "text", "required": false, "description": "Why the order is coming back." }
    ]
  },
  "invocation": { "toolName": "start_return", "outcome": "started" }
}
```

Supply the pending slots in a follow-up `message`; the routine reads them the way it reads any reply. A call with every slot the routine collects runs straight through to its skill steps and reports `status: "completed"`, or `waiting_for_approval` when a step needs a person's decision.

Input is checked against the descriptor before anything is recorded, so a bad call leaves the conversation untouched:

- An unknown tool name returns `404` with `error.details.code` `routine_tool_unknown`.
- Input that does not match the schema returns `400` with `error.details.code` `routine_invocation_invalid` and `error.details.errors`, one entry per field: `{ "path": "orderId", "code": "required" }`, with `code` one of `required`, `type`, `format`, `unknown_field`, or `too_long` (a string value over 2000 characters). String values are trimmed first, and a blank string counts as missing: it fails a required slot and is dropped from an optional one. Fix every listed field in one retry; values are never echoed back.
- A body with both `message` and `routine`, or neither, returns `400`.

`invocation.outcome` tells you what the accepted call did, so you never have to infer it from the answer text:

- `started` — the routine began with your input.
- `reentered` — the routine had already completed in this conversation and started again with the new input, because its reentry setting allows it (**Every time it matches**, or the semantic setting — an explicit call already answers the question that setting asks of a message).
- `declined` — the routine had already completed and **Once per conversation** keeps it closed. The turn answers normally, and `routine` still carries `{ "toolName", "name", "status": "completed", "pendingInput": [] }` so you learn why nothing started.
- `not_started` — a different routine was mid-flight or waiting for an operator's approval, so the existing interruption and approval rules kept the turn: an active routine reads your call like any other message, a suspended one holds it. `routine` describes that routine, so you can see what it still needs.
- `unknown_tool` — the release this conversation runs on carries no routine under that name. The pre-check below normally refuses such a call with `404` before the turn; this outcome covers a release that changed between the check and the turn.

The tool name is checked against the release the conversation is pinned to, on both the MCP ask route and the REST agent channel, before any message is recorded. The conversation behind a session stays on the release it started on, while `GET /api/v1/mcp/converse/tools` returns the agent's current published catalog on every call (the session token only says which agent), so a routine exposed or renamed after the conversation began can appear in `tools` yet return `routine_tool_unknown` when called; rotating the credential starts a fresh conversation on the current release. Draft routines are never listed — the operator's Test Chat is the place to try one.

### Routine tools over standalone MCP

An MCP client sees the same catalog without calling the REST route itself. The standalone server reads `GET /api/v1/mcp/converse/tools` once, at the moment it exchanges the credential for a session, and pins the result to that session, so `tools/list` is stable for the session's lifetime. It is then:

- `ask_agent`
- `radioso_docs` and `radioso_doc_page`, Radioso's own documentation
- one tool per descriptor, named by its `toolName`, carrying the operator's description and the descriptor's `inputSchema` verbatim

So the `start_return` example above appears to the client as a tool `start_return(orderId, reason?)`. Calling it is the routine invocation from the previous section: the server checks the arguments against the schema before the backend sees them (a call missing `orderId` fails at the MCP layer as a tool error, and the server's audit log records the refusal with the tool name only), then sends `{ "routine": { "toolName": "start_return", "input": { … } } }` on the ask route. The result's `structuredContent` is the full agent reply envelope, and its text content is `answer.text` followed by the same envelope as JSON — the same shape `ask_agent` returns, so a client reads `routine.status`, `pendingInput`, and `invocation.outcome` the same way whichever tool it called.

A routine exposed, renamed, or withdrawn after the session opened is picked up when the client's next session is established (after the current one expires, or after the credential is exchanged again); the server sends no `notifications/tools/list_changed`. The backend checks every call against the release the session's conversation is pinned to, so when the pinned catalog and that release disagree the client sees a tool error whose `details.code` is `routine_tool_unknown` and nothing is recorded.

Operators who expose a routine under a name the server reserves for a static tool cannot publish it — the backend refuses reserved names. If a deployment ever presents one anyway, the server keeps the static tool, leaves that routine out of the session's list, and logs a warning.

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
- An agent's public id is not a credential and authorizes nothing by itself.

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

## Discovery Documents

An agent whose operator has published its card is described by three public documents on the API host, scoped to the agent's public id:

```
GET https://api.radioso.ai/.well-known/agent-card/{publicId}.json
GET https://api.radioso.ai/.well-known/mcp/server-card/{publicId}.json
GET https://api.radioso.ai/.well-known/ai-catalog/{publicId}.json
```

The agent card is an A2A Agent Card. It names the agent, the MCP endpoint to connect to, the security schemes that endpoint accepts, and one `skills[]` entry per exposed routine. The server card is the same agent in MCP's server document shape, with the endpoint under `remotes`; the standalone server also answers it one segment past the endpoint, at `GET /mcp/a/{publicId}/server-card`, which is the path an MCP client dereferences when it starts from an endpoint URL rather than a hostname. The catalog entry carries the agent, its endpoint, its authentication, and its tools in one object.

A caller reads `security` on the agent card to learn what it must bring. An empty requirement object means the endpoint accepts a caller with no `Authorization` header; `{ "bearer": [] }` means an operator-minted credential is required. Both are listed when credential-free access is on.

Every document is served with `Cache-Control: max-age=300` and an `ETag`; send `If-None-Match` to revalidate. A public id that is unknown, has its card switched off, belongs to an unpublished agent, or belongs to a deleted one answers `404` with an identical body.

A deployment serves these documents once `PUBLIC_MCP_CONVERSE_URL` names the MCP endpoint, without the per-agent suffix — one agent's endpoint is that value plus `/a/{publicId}`. Until it is set, the card routes answer `500` rather than publish a card whose endpoint is missing or guessed. The link to this guide comes from the documentation corpus the build ships, so there is nothing to configure for it.

## Connect Without a Credential

An operator who turns on **Allow AI agents to connect without a credential** on the agent's **Channels → MCP** card opens a second door: the agent's own endpoint, one segment past the shared one.

```
https://mcp.radioso.ai/mcp/a/{publicId}
```

Point an MCP client at that URL and send no `Authorization` header. The server exchanges a session for you on the first request and answers `tools/list` and `tools/call` exactly as it does for a credential-bound client — `ask_agent` plus one tool per exposed routine.

```json
{
  "mcpServers": {
    "radioso-returns-desk": {
      "url": "https://mcp.radioso.ai/mcp/a/ag_S7Qw2ZmKp1Rr4Yt8Nv6Lbc"
    }
  }
}
```

Each connection gets its own conversation. The server names it in the `Mcp-Session-Id` response header on the first reply; a client that echoes that header on later requests continues the same conversation, and one that drops it starts a new one each call. Most MCP clients handle this for you. The handle is signed and bound to the agent and to the calling source, so one a client invents, or one replayed from somewhere else, names nothing and opens a fresh conversation instead. Self-hosted deployments set `RADIOSO_MCP_SIGNING_SECRET` for this; without it every walk-in call gets a new conversation.

The public id is a routing key, not a secret — it appears in the agent card, in the embed's page markup, and in whatever config the caller saves. It grants exactly what the operator has published: a conversation with that one agent. Rotating it from the dashboard, or turning walk-in access off, refuses the next request on every connection opened against it.

Walk-in traffic is budgeted twice: per calling source, and per agent. The per-agent budget defaults to 60 new conversations an hour and is adjustable on the same card. A caller over either budget gets `429` with `Retry-After` and the `RateLimit-*` headers, which is the signal to back off and retry rather than reconnect. Walk-in conversations are metered on the workspace's conversation quota like every other channel.

The shared `/mcp` endpoint is unchanged and still requires an MCP credential.

## Endpoint Model

The standalone `/mcp` endpoint serves the agent-converse surface. `ask_agent` runs the bound agent's turn loop, and each exposed routine is a tool that starts that routine directly. The original MCP credential fixes the agent and its authorization boundary; standalone performs the credential-to-session exchange and reads the agent's tool catalog at that moment.

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

`require_approval: "never"` skips the host-side prompt. The MCP surface contains `ask_agent`, the documentation tools, and the agent's exposed routines; it does not expose Ray or a skill catalogue.
