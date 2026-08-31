# MCP Server Internals

This package owns the standalone Radioso MCP server runtime: HTTP transport, MCP
tool handlers, agent-converse grant exchange, policy, audit logging, runtime
state, and the backend API adapter.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../docs/architecture/code-map.md).

## Boundaries

The MCP server knows about MCP tool contracts, transport-specific request
handling, auth/session state, policy checks, audit output, and backend API calls
through `radiosoApiAdapter.ts`.

It should not own backend product behavior. If a tool needs new product
behavior, add or change the backend API contract first, then update this package
as a client.

## Read First

- `server.ts`: MCP server construction.
- `tools/readTools.ts` and `tools/writeTools.ts`: tool definitions and handlers.
- `radiosoApiAdapter.ts`: backend API client boundary.
- `http/requestHandler.ts`, `http/runtime.ts`, `http/createHttpServer.ts`: HTTP
  transport runtime.
- `auth/`: auth exchange and session handling.
- `policy/`: capability and workspace policy checks.
- `audit/auditLogger.ts`: audit event output.

## Common Change Paths

- New MCP tool: update tool handlers, result formatting, tests, and docs.
- Backend contract change: regenerate or sync types, update
  `radiosoApiAdapter.ts`, and adjust tool tests.
- HTTP auth/session behavior: update `auth/`, `http/`, and auth tests.
- Policy or audit behavior: update `policy/`, `audit/`, and matching tests.

## Tests

Focused starting points:

- `cd packages/radioso-mcp-server && pnpm test`
- `cd packages/radioso-mcp-server && pnpm run build`
- `cd packages/radioso-mcp-server && pnpm run smoke:all`

Use backend contract checks when the MCP server depends on changed backend API
shape.
