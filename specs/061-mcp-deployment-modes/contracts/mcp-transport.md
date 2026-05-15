# Contract: MCP Transport Mounts

## Backend merged mount

`POST /mcp` by default, or `POST {RADIOSO_MCP_MOUNT_PATH}` when configured.

Headers:

- `Authorization: Bearer <workspace-api-token>`
- `Content-Type: application/json`
- `Mcp-Protocol-Version: <client protocol version>`

Behavior:

- Valid workspace API tokens authenticate directly.
- Missing or revoked tokens return JSON-RPC `invalid_access_token`.
- Requests use the same MCP tool catalog, policy enforcement, approval checks, and audit handling as standalone mode.
- The route is not registered when `RADIOSO_MCP_ENABLED=false` or `RADIOSO_MCP_STANDALONE=true`.

## Standalone mount

`POST /mcp` on the standalone MCP HTTP service.

Headers:

- `Authorization: Bearer <mcp_sess token from /v1/auth/exchange>`

Behavior:

- Existing exchange and approval routes remain unchanged.
- Existing standalone smoke suites remain valid.

## Backend health

`GET /health`

Response includes:

- `status`
- `mcp.mode`
- `mcp.enabled`
- `mcp.path`
