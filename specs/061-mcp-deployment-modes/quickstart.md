# Quickstart: MCP Server Deployment Modes

## Merged backend mode

1. Set `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false`.
2. Set `RADIOSO_BASE_URL` to the backend origin and keep `RADIOSO_MCP_SIGNING_SECRET` aligned with existing MCP attribution settings.
3. Start the backend.
4. Connect an MCP client to `{backend-origin}/mcp`.
5. Use the workspace API token directly as `Authorization: Bearer <workspace-api-token>`.

Expected result: `tools/list` succeeds without calling `/v1/auth/exchange`.

## Standalone mode

1. Leave the backend with `RADIOSO_MCP_ENABLED=false`.
2. Start `packages/radioso-mcp-server` as a separate HTTP service.
3. Exchange a workspace API token with `POST /v1/auth/exchange`.
4. Connect to the standalone `{mcp-origin}/mcp` endpoint with the returned short-lived MCP access token.

Expected result: existing standalone smoke tests pass unchanged.

## Hybrid mode

1. Set backend `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false`.
2. Run a standalone MCP server pointed at the same backend.
3. Configure `RADIOSO_MCP_REDIS_URL` for both entry points when shared session and approval state is required.

Expected result: internal clients can use the backend `/mcp` route with workspace tokens while public clients continue to use the standalone exchange flow.
