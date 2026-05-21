# Quickstart: Remote MCP Context Server

> **Amendment 2026-05-19**: `POST /v1/approvals` no longer exists. Skip any step in older docs that calls it and proceed directly to the write `tools/call`. Write tools that advertise `requiresApproval: true` should be prompted at the host (Cursor / Claude Desktop / ChatGPT); the server does not gate them.

## Prerequisites

- A running Radioso backend reachable at `RADIOSO_BASE_URL`
- A valid Radioso workspace API token for the target workspace
- Node.js 24+

## Install dependencies

```bash
cd /Users/dm/conductor/workspaces/radioso/milan/packages/radioso-mcp-server
npm install
```

## Build the package

```bash
npm run build
```

## Start the remote MCP server

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_MCP_BIND_HOST=127.0.0.1 \
RADIOSO_MCP_BIND_PORT=8787 \
RADIOSO_MCP_SIGNING_SECRET=dev-signing-secret \
node dist/src/cli/http.js
```

## Exchange a workspace token for an MCP access token

```bash
ACCESS_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/auth/exchange \
    -H 'content-type: application/json' \
    -d '{
      "radiosoApiToken": "radioso_example",
      "clientName": "quickstart",
      "requestedTools": ["describe_capabilities","search_documents","answer_grounded","create_document"]
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
        "name": "quickstart",
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

## Read flow smoke test

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

## Request a write approval

```bash
APPROVAL_TOKEN=$(
  curl -s http://127.0.0.1:8787/v1/approvals \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H 'content-type: application/json' \
    -d '{
      "reason": "quickstart document creation",
      "tools": ["create_document"]
    }' \
  | jq -r '.approvalToken'
)
```

## Write flow smoke test

```bash
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
        \"title\": \"Quickstart document\",
        \"content\": \"Created through the remote MCP server.\",
        \"approvalToken\": \"$APPROVAL_TOKEN\"
      }
    }
  }"
```

## Validation targets

- Package unit tests pass.
- Remote auth exchange, approval issuance, and MCP JSON-RPC smoke flows pass.
- Existing backend behavior remains unchanged because the package uses only the HTTP contract.
- Manual read and write flows complete against a local Radioso stack without using the Radioso web app.
