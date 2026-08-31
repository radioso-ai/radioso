# Radioso MCP Server

MCP server package that lets an MCP client talk to a Radioso agent through its turn loop, and read or write the workspace documents that agent answers from.

## What It Does

The package connects to an existing Radioso deployment over its public HTTP API and exposes two surfaces.

**Agent converse surface.** A client talks to one agent through that agent's turn loop, using a per-agent converse grant. The agent applies its own persona, the directives that steer it, and any routine carrying the conversation across turns, so an MCP client reaches it through the same loop as every other channel. Tools:

- `ask_agent` for a full agent reply (persona, directives, routines, history)
- `answer_grounded` over the bound agent's retrieval settings
- the agent's documents as read-only MCP resources

**Workspace document tools.** The package contains retrieval-first tools scoped to a whole workspace, but the MCP credential boundary does not accept personal or service-account REST credentials. Workspace credentials from the pre-migration verifier are invalid after upgrade, so these tools are not an eligible MCP entry point in this feature.

The two credential families remain separate. An agent-converse grant is the supported MCP credential, and it is not interchangeable with a REST credential. A workspace REST credential cannot be used as an agent-converse grant.

The package owns MCP protocol handling, token verification seams, capability policy enforcement, and audit logging. For the agent-converse surface, the backend owns session issuance and per-request grant checks; the package calls the backend converse endpoints over HTTP. The package does not import backend domain modules and does not access the database directly.

## Remote Runtime

The package supports two HTTP runtimes:

- **Standalone**: run the package as its own process. The HTTP endpoint accepts an agent-converse grant; personal and service-account REST credentials are rejected by the exchange and MCP authentication paths.
- **Merged**: the backend imports the package's public HTTP runtime contract and mounts MCP at its own `/mcp` route. Personal and service-account REST credentials are rejected at the MCP boundary.

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

Capability allowlists remain package configuration for the internal tool catalog. This credential change does not add a new tool-filtering surface or server-side approval flow.

When `RADIOSO_MCP_REDIS_URL` is omitted, the server stays in documented in-memory single-node mode. When it is set, session state moves into Redis so multiple MCP server instances can serve the same session.

Before either runtime reports readiness or serves MCP traffic, its controlled runtime store purges persisted sessions containing legacy upstream credentials. Redis performs a namespace-scoped `SCAN` and removes the matching session records and token indexes. If the configured store is unavailable, the runtime stays unavailable and retries; it does not switch to another store. Cached sessions revalidate their upstream credential on each request, so a stale copy held by another deployment fails when the backend rejects that credential.

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

- `pnpm run smoke:http` starts the backend's in-memory test app and verifies that a workspace REST credential is rejected before an MCP session is created.
- `pnpm run smoke:redis` starts two MCP HTTP instances with a shared Redis store and verifies the same rejection on both nodes. It uses `RADIOSO_MCP_SMOKE_REDIS_URL` when provided, otherwise it starts a disposable local Redis instance with `redis-server` or Docker.
- `pnpm run smoke:all` runs both.

## Start The Remote HTTP Server

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
RADIOSO_MCP_SIGNING_SECRET=dev-signing-secret \
node dist/src/cli/http.js
```

The workspace MCP context endpoint is available only to a signed-in dashboard session. It is not part of standalone MCP credential setup. Agent-converse grants use the separate converse session flow.

## Credential Eligibility

Personal REST credentials and service-account REST credentials receive the same generic unauthorized response from merged MCP, standalone `/v1/auth/exchange`, and stdio preflight. The exchange path does not enumerate credential classes.

When an installation is upgraded, the backend destroys the legacy workspace-token verifier material. A retained copy in another MCP deployment cannot create a usable session: its next upstream validation fails, and any cached session is removed locally.

Agent-converse grants use the separate `/api/v1/mcp/converse/session` flow. Pass the resulting grant or session bearer to the MCP converse surface; do not pass a REST credential to that surface.

## Client Setup

Cursor can connect to a local config that points at `http://127.0.0.1:8787/mcp` and reads an eligible agent-converse bearer from `RADIOSO_MCP_ACCESS_TOKEN`. Create that bearer through the agent-converse grant flow described in [`../../docs/mcp-client-setup.md`](../../docs/mcp-client-setup.md).

Claude, Claude Desktop remote connectors, ChatGPT apps, and OpenAI-hosted remote MCP flows require a public HTTPS deployment of this server. They do not connect to `localhost` from your laptop. See [`../../docs/mcp-client-setup.md`](../../docs/mcp-client-setup.md) for the agent-converse credential flow and deployment boundaries.

## Initialize MCP

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $RADIOSO_MCP_ACCESS_TOKEN" \
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
  -H "authorization: Bearer $RADIOSO_MCP_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "method": "notifications/initialized",
    "params": {}
  }'
```

## Agent Converse Flow

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $RADIOSO_MCP_ACCESS_TOKEN" \
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

The converse surface exposes `ask_agent`, `answer_grounded`, and the agent's documents as read-only MCP resources. Workspace document writes are not available through the REST credential paths described above.

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $RADIOSO_MCP_ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d '{
    "jsonrpc": "2.0",
    "id": "ask-1",
    "method": "tools/call",
    "params": {
      "name": "ask_agent",
      "arguments": {
        "message": "What is the refund window?"
      }
    }
  }'
```

## Stdio workspace mode

The stdio workspace credential preflight rejects shared workspace credentials, personal tokens, and service-account credentials. Use the HTTP agent-converse surface instead; an agent-converse grant is not interchangeable with `RADIOSO_API_TOKEN`.

## Scope

A converse grant carries `ask_agent`, `answer_grounded`, and the agent's documents as read-only resources. This package change covers credential eligibility, legacy verifier cleanup, and runtime readiness. It introduces no OAuth flow, REST-credential tool filtering, skills catalogue, or Ray access.
