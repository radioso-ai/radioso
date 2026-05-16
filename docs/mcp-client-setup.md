# MCP Client Setup

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
2. Exchange a Radioso workspace token for an MCP access token:

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

## Endpoint Model

MCP is retrieval-first by default. Tools such as `search_documents` and `answer_grounded` call Radioso retrieval and document endpoints directly. They do not create assistant conversations and they do not inherit assistant persona, greeting, or social-reply behavior.

In practice:

- Use MCP `answer_grounded` when a client wants a grounded answer from workspace documents.
- Use MCP document tools when a client wants document capability access.
- Use `POST /api/v1/assistant/chat` only when the integration explicitly wants the customer-facing assistant chat product.

The retrieval answer endpoint accepts optional `conversationContext` hints for rewrite continuity. The caller owns those hints. Radioso retrieval uses them to improve the search query, but retrieval does not become the owner of assistant chat history.

For debugging, MCP grounded-answer calls are marked in retrieval diagnostics as `mcp_capability` executions. This keeps them separate from direct retrieval API calls and assistant-backed chat turns.

Grounded-answer diagnostics also include retrieval shape metadata in the `activityTrace` graph and `activitySummary`. Look for the `shape_selection` stage and summary fields such as `shapeName`, `queryShape`, `resolvedSteps`, and `skillDiagnostic`. These fields explain which resolved retrieval shape and step overrides were applied.

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
- Set `RADIOSO_API_TOKEN` (your workspace token, `radioso_...`)
- Ensure `pnpm install --filter @radioso/mcp-server...` has been run so the `cursor:mcp-stdio` entrypoint can run.

## Claude And Claude Desktop Remote Connectors

Claude custom connectors are true remote connectors. Anthropic connects to your MCP server from Anthropic's cloud infrastructure, not from your laptop, so `http://127.0.0.1:8787/mcp` will not work there.

To use Radioso from Claude or Claude Desktop as a remote connector:

1. Deploy the MCP server to a public HTTPS URL such as `https://mcp.example.com/mcp`.
2. Add connector-compatible authentication in front of that public deployment. The current package ships its own `/v1/auth/exchange` flow, which works for local and API-driven clients, but it is not a native Claude connector auth flow yet.
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
2. Add app-compatible authentication. In practice that means OAuth or OpenID Connect with refresh-token support. The current package's `/v1/auth/exchange` flow is not enough for native ChatGPT app onboarding by itself.
3. In ChatGPT workspace settings, enable developer mode and create a custom app from that MCP server URL.
4. If your deployment uses OAuth or OpenID Connect, configure refresh-token-capable auth before publishing.
5. Connect the app in ChatGPT and test both read paths and approval-gated writes.

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

`require_approval: "never"` is suitable for read-only OpenAI API use. The current Radioso server uses explicit approval gating for write tools, so deep-research-style API clients should stay read-only unless you intentionally deploy a separate policy profile for that integration. If your hosted Radioso MCP endpoint is not public and unauthenticated, you will also need an OpenAI-compatible auth layer before this can be used from ChatGPT apps or OpenAI-hosted flows.
