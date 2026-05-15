# Data Model: MCP Server Deployment Modes

## MCP Deployment Configuration

- `RADIOSO_MCP_ENABLED=false`: backend does not mount MCP; `/mcp` returns 404 through normal routing.
- `RADIOSO_MCP_ENABLED=true` with `RADIOSO_MCP_STANDALONE=false`: backend mounts MCP at `RADIOSO_MCP_MOUNT_PATH` and accepts workspace API tokens directly.
- `RADIOSO_MCP_STANDALONE=true`: backend skips the same-host mount; standalone MCP server remains the supported MCP entry point.

Validation: `RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE` are boolean env vars. Both default to `false`.

## MCP Request Handler

Fields:

- `config`: shared MCP configuration used for tool policy, audit, Redis/session storage, upstream Radioso base URL, and signing.
- `verifyBearerToken`: strategy that resolves the request bearer to an access-session record.
- `serverManager`: session-aware MCP server transport manager.

Relationships:

- Used by standalone HTTP server with exchanged-token verifier.
- Used by backend Express mount with workspace-token verifier.

## Token Verifier

Implementations:

- `exchangedAccessTokenVerifier`: reads existing MCP session store using the short-lived `mcp_sess_...` token.
- `workspaceApiTokenVerifier`: authenticates a backend workspace API token and returns an ephemeral MCP session containing the same upstream token.

Validation:

- Missing or invalid bearer returns JSON-RPC `invalid_access_token`.
- Merged verification re-checks the backend token for every request.

## MCP Mount Health

Fields:

- `enabled`: whether merged MCP is mounted.
- `mode`: configured MCP deployment mode.
- `path`: configured mount path.

Relationship:

- Included in backend health responses so operators can confirm mount status.
