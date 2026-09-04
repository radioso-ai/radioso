# Radioso MCP Server

MCP server package for one-agent conversation and a separate OAuth-protected Ray operator surface.

## What It Does

The package connects to an existing Radioso deployment over its public HTTP API and exposes one MCP surface.

**Agent converse surface (`/mcp`).** A client talks to one agent through that agent's turn loop, using an agent-bound MCP channel credential. The agent applies its own persona, directives, and routines. The sole tool is:

- `ask_agent` for a full agent reply (persona, directives, routines, history)

**Operator surface (`/operator/mcp`).** An OAuth-capable remote client acts as the signed-in person who granted access. Its fresh catalog can expose `workspace_settings`, `retrieval_probe`, and `propose_ingestion_settings` when current scopes and permissions allow them. See [Operator MCP OAuth access](../../docs/operator-mcp.md) for consent, grant management, and compatibility status.


The package owns MCP protocol handling, agent-channel credential validation seams, and audit logging. The backend owns session issuance and per-request grant checks; the package calls the backend converse endpoints over HTTP. The package does not import backend domain modules and does not access the database directly.

## Remote Runtime

The package provides one HTTP runtime:

- **Standalone**: run the package as its own process. The HTTP `/mcp` endpoint accepts the original agent-converse grant and exchanges it internally.

The package has no stdio MCP entrypoint.

### Required Environment Variables

- `RADIOSO_BASE_URL`

Operator MCP additionally requires these values in both the standalone service and backend:

- `OPERATOR_MCP_ENABLED=true`
- `OPERATOR_MCP_RESOURCE_URL`, the exact HTTPS resource ending in `/operator/mcp`
- `OPERATOR_MCP_ISSUER_URL`, the HTTPS Radioso authorization-server origin
- `OPERATOR_MCP_INTERNAL_SECRET`, the same exact value in both processes, at least 32 characters
- `OPERATOR_MCP_CREDENTIAL_EPOCH`, an externally managed positive decimal generation

### Common Optional Environment Variables

- `RADIOSO_MCP_BIND_HOST` default `127.0.0.1`
- `RADIOSO_MCP_BIND_PORT` default `8787`
- `RADIOSO_MCP_SERVER_NAME` default `radioso-context`
- `RADIOSO_MCP_REQUEST_TIMEOUT_MS` default `30000`
- `RADIOSO_MCP_AUDIT_LOG_PATH`
- `RADIOSO_MCP_REDIS_URL` enables a shared runtime store for sessions
- `RADIOSO_MCP_REDIS_KEY_PREFIX` default `radioso-mcp`
- `RADIOSO_MCP_SIGNING_SECRET` lets standalone MCP carry its digested client-source identity to the backend with a signed proof. It is also required with `RADIOSO_MCP_REDIS_URL`, where it encrypts persisted backend session material. Use at least 32 random characters.
- `RADIOSO_TRUSTED_PROXY_HOPS` default `0`. Set it only when requests arrive through a proxy chain whose rightmost hops are controlled by your deployment.

Hosted Terraform generates `RADIOSO_MCP_SIGNING_SECRET`, injects the same value into standalone MCP and the backend, and sets `RADIOSO_TRUSTED_PROXY_HOPS=2` for Google's appended `<client-ip>,<load-balancer-ip>` suffix. Caller-supplied values earlier in the header are ignored. For a manual deployment, set the same signing value in both processes and configure the hop count only when you control the rightmost proxy chain. With the default `0`, both services ignore forwarded addresses and budget requests by their direct socket peer.

When `RADIOSO_MCP_REDIS_URL` is omitted, the standalone server keeps short-lived backend session tokens in memory. After a restart or cache miss, it exchanges the original credential again; the backend retains that credential version's conversation identity in PostgreSQL. When Redis is set, that cache is shared across standalone MCP instances and its session tokens are encrypted with the signing secret.

Before standalone MCP reports readiness or serves traffic, Redis removes persisted records carrying historical upstream API-token fields. The purge is namespace-scoped and removes matching session records and token indexes. If the configured store is unavailable, standalone stays unavailable and retries.

## Install And Build

```bash
cd packages/radioso-mcp-server
pnpm install --filter @radioso/mcp-server...
pnpm run build
```

## Safe Smoke Tests

The package includes smoke commands that do not touch your existing Radioso PostgreSQL data.

- `pnpm run smoke:http` starts the backend's in-memory test app and completes an `ask_agent` call through the standalone MCP server.
- `pnpm run smoke:redis` starts two MCP HTTP instances with a shared Redis store and completes an `ask_agent` call through the shared session. It uses `RADIOSO_MCP_SMOKE_REDIS_URL` when provided, otherwise it starts a disposable local Redis instance with `redis-server` or Docker.
- `pnpm run smoke:all` runs both.

## Start The Remote HTTP Server

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
node dist/src/cli/http.js
```

Agent-bound MCP channel credentials are issued by the signed-in dashboard. Put the credential in the `Authorization` header sent to standalone `/mcp`; the server establishes the agent session internally.

## Client Setup

Cursor can connect to a local config that points at `http://127.0.0.1:8787/mcp` and reads the original agent-converse grant from `RADIOSO_MCP_ACCESS_TOKEN`. Create that grant through the flow described in [`../../docs/mcp-client-setup.md`](../../docs/mcp-client-setup.md).

Claude, Claude Desktop remote connectors, ChatGPT apps, and OpenAI-hosted remote MCP flows require a public HTTPS deployment of this server. They do not connect to `localhost` from your laptop. See [`../../docs/mcp-client-setup.md`](../../docs/mcp-client-setup.md) for the agent-converse credential flow and deployment boundaries.

Operator MCP setup starts under **Settings → API access**. Named client choices remain unavailable until the exact build has complete compatibility evidence; the generic remote HTTP option is labelled unverified. The dashboard supplies the canonical resource URL and browser consent flow.

## Operator OAuth Resource

The operator transport is stateless and uses MCP protocol `2026-07-28`. It accepts `ping`, `tools/list`, and `tools/call` without an initialize exchange. The standalone service validates the Bearer header, applies independent source and principal limits, and asks the backend for a short-lived signed admission proof. The backend rechecks the credential row, grant version, client snapshot, external credential epoch, membership, user status, scope, and current descriptor permission before listing or invoking.

The backend catalog is never cached by the standalone process. A permission or grant change therefore takes effect on the next request.

Use these checks after changing the backend contract:

```bash
pnpm run sync:openapi
pnpm run check:openapi
pnpm run build
pnpm test
```

Startup checks the configured credential epoch and internal-secret fingerprint against persisted deployment state. It does not advance the epoch. Rotate or restore by explicitly persisting a greater external epoch, then deploy the same epoch and secret to every enabled replica.

## Initialize MCP

Set `RADIOSO_MCP_ACCESS_TOKEN` to the agent-bound MCP channel credential. Standalone establishes the session when the first `/mcp` request arrives.

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

The converse surface exposes only `ask_agent`. Document tools, direct grounded answers, and resources are intentionally not part of this package.

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

## Scope

An agent-bound MCP credential carries only `ask_agent`. This package covers session validation and runtime readiness.
