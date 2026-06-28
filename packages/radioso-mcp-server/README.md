# Radioso MCP Server

MCP server package for the per-agent converse surface and workspace-scoped Radioso reads and writes.

## What It Does

The package connects to an existing Radioso deployment over its public HTTP API and exposes two surfaces.

**Agent converse surface.** A client talks to one agent through that agent's turn loop, using a per-agent converse grant. Tools:

- `ask_agent` for a full agent reply (persona, directives, routines, history)
- `answer_grounded` over the bound agent's retrieval settings
- the agent's documents as read-only MCP resources

**Workspace document tools.** Retrieval-first tools scoped to a whole workspace, using a workspace API token:

- grounded answers with citations
- document listing, lookup, and search
- document create, update, delete, and reprocess

The two surfaces use separate credentials and do not cross. A workspace API token is rejected by the converse surface, and a converse grant is rejected by the workspace tools.

The package owns MCP protocol handling, token verification seams, capability policy enforcement, and audit logging. For the workspace tools, authorization comes from the workspace API token and the tools the MCP session was granted at exchange time; the package does not implement a separate server-side approval gate. Tools that should prompt the user before execution are advertised with `requiresApproval: true` so the MCP host (Cursor, Claude Desktop, ChatGPT) can show its own confirmation UI. For the converse surface, the backend owns session issuance and per-request grant checks; the package calls the backend converse endpoints over HTTP. The package does not import backend domain modules and does not access the database directly.

## Remote Runtime

The package supports two HTTP runtimes:

- **Standalone**: run the package as its own process. Clients exchange a workspace API token for a short-lived MCP access token.
- **Merged**: the backend imports the package's public HTTP runtime contract and mounts MCP at its own `/mcp` route. Clients use the workspace API token directly.

Standalone remains the recommended shape for public connector surfaces. Merged mode is intended for same-host self-hosted installs.

### Required Environment Variables

- `RADIOSO_BASE_URL`
- `RADIOSO_MCP_SIGNING_SECRET` must be explicitly set to a non-default secret in remote mode

The target Radioso backend must also have the same `RADIOSO_MCP_SIGNING_SECRET` configured so it can verify MCP-attributed chat traffic before marking history entries as MCP-originated.

### Common Optional Environment Variables

- `RADIOSO_MCP_BIND_HOST` default `127.0.0.1`
- `RADIOSO_MCP_BIND_PORT` default `8787`
- `RADIOSO_MCP_SERVER_NAME` default `radioso-context`
- `RADIOSO_MCP_REQUEST_TIMEOUT_MS` default `30000`
- `RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS` default `900`
- `RADIOSO_MCP_ALLOWED_READ_TOOLS`
- `RADIOSO_MCP_ALLOWED_WRITE_TOOLS`
- `RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS` per-tool list that toggles the `requiresApproval` advertisement MCP hosts read when deciding whether to prompt
- `RADIOSO_MCP_AUDIT_LOG_PATH`
- `RADIOSO_MCP_REDIS_URL` enables a shared runtime store for sessions
- `RADIOSO_MCP_REDIS_KEY_PREFIX` default `radioso-mcp`
- `RADIOSO_MCP_WORKSPACE_POLICIES_PATH` path to a JSON file with workspace-specific policy overrides
- `RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE` are read by the backend, not the standalone package. Use `RADIOSO_MCP_ENABLED=true` with `RADIOSO_MCP_STANDALONE=false` to mount the backend route.
- `RADIOSO_MCP_MOUNT_PATH` backend merged route path, default `/mcp`
- `RADIOSO_MCP_MERGED_CORS_ORIGINS` backend merged CORS allowlist, default `*`

If the tool allowlists are omitted, the package enables the full current read/write catalog. All write tools default to `requiresApproval: true` so MCP hosts will prompt the user before execution. The package does not enforce approval server-side beyond the workspace API token's underlying permissions.

When `RADIOSO_MCP_REDIS_URL` is omitted, the server stays in documented in-memory single-node mode. When it is set, session state moves into Redis so multiple MCP server instances can serve the same session.

Workspace policy files use this JSON shape:

```json
{
  "workspaces": {
    "3f3caef3-050c-46a7-8fd7-2fa48f17fe98": {
      "allowedReadTools": ["describe_capabilities", "list_documents"],
      "allowedWriteTools": ["create_document"],
      "approvalRequiredWriteTools": ["create_document"]
    }
  }
}
```

## Install And Build

```bash
cd packages/radioso-mcp-server
pnpm install --filter @radioso/mcp-server...
pnpm run build
```

## Safe Smoke Tests

The package includes smoke commands that do not touch your existing Radioso PostgreSQL data.

- `pnpm run smoke:http` starts the backend's in-memory test app and runs a real remote MCP read/write flow against it.
- `pnpm run smoke:redis` runs the same style of flow across two MCP HTTP instances with a shared Redis store. It uses `RADIOSO_MCP_SMOKE_REDIS_URL` when provided, otherwise it starts a disposable local Redis instance with `redis-server` or Docker.
- `pnpm run smoke:all` runs both.

## Start The Remote HTTP Server

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
RADIOSO_MCP_SIGNING_SECRET=dev-signing-secret \
node dist/src/cli/http.js
```

The remote package requires `GET /api/v1/workspace/mcp/context` on the target Radioso backend. It uses that route to negotiate workspace identity and supported MCP capabilities before granting tools to the client.

## Exchange A Workspace Token

```bash
ACCESS_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/auth/exchange \
    -H 'content-type: application/json' \
    -d '{
      "radiosoApiToken": "radioso_example",
      "clientName": "operator-shell",
      "requestedTools": ["describe_capabilities","list_documents","answer_grounded","create_document"]
    }' \
  | jq -r '.accessToken'
)
```

For Cursor or other local clients that read bearer tokens from the environment, use the helper script:

```bash
source <(
  RADIOSO_WORKSPACE_TOKEN=radioso_example \
  pnpm run -s token:exchange
)
```

On macOS, if you launch Cursor from the Dock or Spotlight instead of from Terminal, install the token into the GUI app environment first:

```bash
RADIOSO_WORKSPACE_TOKEN=radioso_example \
pnpm run -s cursor:prepare -- --open
```

That uses `launchctl setenv RADIOSO_MCP_ACCESS_TOKEN ...` and opens a fresh Cursor instance. If Cursor was already running, fully quit it before reopening so it picks up the new token.

## Client Setup

Cursor can connect to a local config that points at `http://127.0.0.1:8787/mcp` and reads the bearer token from `RADIOSO_MCP_ACCESS_TOKEN`.

Cursor can use that local config directly once you export an access token with `pnpm run -s token:exchange`.

Claude, Claude Desktop remote connectors, ChatGPT apps, and OpenAI-hosted remote MCP flows require a public HTTPS deployment of this server. They do not connect to `localhost` from your laptop, and the current package's `/v1/auth/exchange` flow is not a native cloud-connector auth mechanism by itself. See [`../../docs/mcp-client-setup.md`](../../docs/mcp-client-setup.md) for the exact split between local Cursor usage, Anthropic API usage with a pre-minted token, and hosted Claude/OpenAI connector requirements.

## Initialize MCP

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "init-1",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": {
        "name": "operator-shell",
        "version": "1.0.0"
      }
    }
  }'

curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
    "params": {}
  }'
```

## Read Flow

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "tools-1",
    "method": "tools/list",
    "params": {}
  }'
```

## Write Flow

Write tools execute as soon as the session-granted access token is valid and the workspace permission backing the tool is satisfied on the upstream Radioso backend. Tools listed in `approvalRequiredWriteTools` advertise `requiresApproval: true` so MCP hosts (Cursor, Claude Desktop, ChatGPT) can show their own confirmation UI before sending the call.

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "write-1",
    "method": "tools/call",
    "params": {
      "name": "create_document",
      "arguments": {
        "title": "Remote MCP doc",
        "content": "Created by the remote MCP server."
      }
    }
  }'
```

## Stdio Compatibility

The package still supports a local stdio path for existing workflows:

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_API_TOKEN=radioso_example \
node dist/src/cli/stdio.js
```

If `RADIOSO_MCP_SIGNING_SECRET` is omitted in stdio mode, the package uses the reserved compatibility secret internally. Remote HTTP mode does not allow that fallback.

If you want stdio-originated `answer_grounded` traffic to be labeled as `MCP` in Radioso history, explicitly set `RADIOSO_MCP_SIGNING_SECRET` in stdio mode to the same non-default secret the backend is using.

## Available Tools

- `describe_capabilities`
- `list_documents`
- `get_document`
- `search_documents`
- `answer_grounded`
- `create_document`
- `update_document`
- `delete_document`
- `reprocess_document`
