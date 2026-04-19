# Radioso MCP Server

Standalone MCP server package for workspace-scoped Radioso reads and writes.

## What It Does

The package connects to an existing Radioso deployment over its public HTTP API and exposes a focused MCP tool catalog for:

- grounded answers with citations
- document listing, lookup, and search
- document create, update, delete, and reprocess
- retrieval settings reads and partial updates

The package does not import backend domain modules and does not access the database directly.

## Required Environment Variables

- `RADIOSO_BASE_URL`
- `RADIOSO_API_TOKEN`
- `RADIOSO_SERVER_NAME` (optional)

## Install And Build

```bash
cd packages/radioso-mcp-server
npm install
npm run build
```

## Start Over Stdio

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
