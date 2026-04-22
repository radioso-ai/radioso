# Radioso MCP Server

Standalone MCP server package for workspace-scoped Radioso reads and writes.

## What It Does

The package connects to an existing Radioso deployment over its public HTTP API and exposes a focused MCP tool catalog for:

- grounded answers with citations
- document listing, lookup, and search
- document create, update, delete, and reprocess
- retrieval settings reads and partial updates

The package owns its own remote HTTP surface, token exchange, approval-gated write flow, and audit logging. It does not import backend domain modules and does not access the database directly.

## Remote Runtime

The remote HTTP server is the primary product surface.

### Required Environment Variables

- `RADIOSO_BASE_URL`
- `RADIOSO_MCP_SIGNING_SECRET`

### Common Optional Environment Variables

- `RADIOSO_MCP_BIND_HOST` default `127.0.0.1`
- `RADIOSO_MCP_BIND_PORT` default `8787`
- `RADIOSO_MCP_SERVER_NAME` default `radioso-context`
- `RADIOSO_MCP_REQUEST_TIMEOUT_MS` default `30000`
- `RADIOSO_MCP_ACCESS_TOKEN_TTL_SECONDS` default `900`
- `RADIOSO_MCP_APPROVAL_TTL_SECONDS` default `300`
- `RADIOSO_MCP_ALLOWED_READ_TOOLS`
- `RADIOSO_MCP_ALLOWED_WRITE_TOOLS`
- `RADIOSO_MCP_APPROVAL_REQUIRED_WRITE_TOOLS`
- `RADIOSO_MCP_AUDIT_LOG_PATH`
- `RADIOSO_MCP_REDIS_URL` enables a shared runtime store for sessions and approvals
- `RADIOSO_MCP_REDIS_KEY_PREFIX` default `radioso-mcp`
- `RADIOSO_MCP_WORKSPACE_POLICIES_PATH` path to a JSON file with workspace-specific policy overrides

If the tool allowlists are omitted, the package enables the full current read/write catalog and requires approval for all write tools.

When `RADIOSO_MCP_REDIS_URL` is omitted, the server stays in documented in-memory single-node mode. When it is set, exchange and approval state move into Redis so multiple MCP server instances can serve the same session.

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
npm install
npm run build
```

## Start The Remote HTTP Server

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
RADIOSO_MCP_SIGNING_SECRET=dev-signing-secret \
node dist/src/cli/http.js
```

On newer Radioso deployments the remote package first calls `GET /api/v1/workspace/mcp/context` to negotiate workspace identity and supported MCP capabilities before granting tools to the client. Older deployments still fall back to a legacy token validation path.

## Exchange A Workspace Token

```bash
ACCESS_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/auth/exchange \
    -H 'content-type: application/json' \
    -d '{
      "radiosoApiToken": "sk_proj_example",
      "clientName": "operator-shell",
      "requestedTools": ["describe_capabilities","list_documents","answer_grounded","create_document"]
    }' \
  | jq -r '.accessToken'
)
```

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

## Approval-Gated Write Flow

```bash
APPROVAL_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/approvals \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H 'content-type: application/json' \
    -d '{
      "reason": "create onboarding doc",
      "tools": ["create_document"]
    }' \
  | jq -r '.approvalToken'
)

curl -s http://127.0.0.1:8787/mcp \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-11-25' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": \"write-1\",
    \"method\": \"tools/call\",
    \"params\": {
      \"name\": \"create_document\",
      \"arguments\": {
        \"title\": \"Remote MCP doc\",
        \"content\": \"Created by the remote MCP server.\",
        \"approvalToken\": \"$APPROVAL_TOKEN\"
      }
    }
  }"
```

## Stdio Compatibility

The package still supports a local stdio path for existing workflows:

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_API_TOKEN=sk_proj_example \
node dist/src/cli/stdio.js
```

## Available Tools

- `describe_capabilities`
- `list_documents`
- `get_document`
- `search_documents`
- `answer_grounded`
- `get_retrieval_settings`
- `create_document`
- `update_document`
- `delete_document`
- `reprocess_document`
- `update_retrieval_settings`
