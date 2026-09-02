# MCP Server Internals

This package owns the standalone Radioso MCP server runtime: HTTP transport, MCP
tool handlers, agent-channel credential validation, audit logging, runtime
state, and the backend converse API adapter.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../docs/architecture/code-map.md).

## Boundaries

The MCP server knows about MCP tool contracts, transport-specific request
handling, auth/session state, audit output, and backend conversation calls
through `converseApiAdapter.ts`.

It should not own backend product behavior. If a tool needs new product
behavior, add or change the backend API contract first, then update this package
as a client.

## Read First

- `server.ts`: MCP server construction.
- `tools/converseTools.ts`: the sole `ask_agent` tool definition and handler.
- `converseApiAdapter.ts`: backend agent-converse API boundary.
- `http/requestHandler.ts`, `http/runtime.ts`, `http/createHttpServer.ts`: HTTP
  transport runtime.
- `auth/`: agent-channel credential validation and session handling.
- `audit/auditLogger.ts`: audit event output.

## Common Change Paths

- New MCP tool: update `tools/converseTools.ts`, result formatting, tests, and docs. The public catalog is intentionally limited to `ask_agent`.
- Backend contract change: update `converseApiAdapter.ts` and adjust tool tests.
- HTTP auth/session behavior: update `auth/`, `http/`, and auth tests.
- Audit behavior: update `audit/` and matching tests.

## Tests

Focused starting points:

- `cd packages/radioso-mcp-server && pnpm test`
- `cd packages/radioso-mcp-server && pnpm run build`
- `cd packages/radioso-mcp-server && pnpm run smoke:all`

Use backend contract checks when the MCP server depends on changed backend API
shape.
