# Quickstart: MCP Context Server

## Prerequisites

- A running Radioso backend reachable at `RADIOSO_BASE_URL`
- A valid workspace API token for the target workspace
- Node.js 22+

## Install dependencies

```bash
cd /Users/dm/conductor/workspaces/radioso/milan/packages/radioso-mcp-server
npm install
```

## Build local package dependencies

```bash
npm --prefix /Users/dm/conductor/workspaces/radioso/milan/typescript-sdk run build
npm run build
```

## Start the MCP server over stdio

```bash
RADIOSO_BASE_URL=http://localhost:8080 \
RADIOSO_API_TOKEN=sk_proj_example \
node dist/src/cli/stdio.js
```

## Expected smoke flow

1. Connect an MCP-capable client to the `stdio` command above.
2. Call `describe_capabilities` and confirm both read and write tools are listed.
3. Call `list_documents` and verify only workspace-scoped documents are returned.
4. Call `answer_grounded` with a known question and verify the response includes citations.
5. Call `create_document`, then `get_document`, then `delete_document` and confirm the lifecycle succeeds without using the Radioso web app.

## Validation targets

- Package unit tests pass.
- Existing backend and SDK tests relevant to the reused contract surface remain green.
- Manual MCP smoke flow completes against a local Radioso stack.
