# Remote HTTP Contract Notes

The remote MCP package owns these HTTP endpoints. They are package-local contracts, not backend routes.

> **Amendment 2026-05-19**: `POST /v1/approvals` and the server-side approval-token verification it powered have been removed. Authorization is the workspace API token plus the tools granted at exchange time; the underlying workspace permission is enforced at the upstream Radioso REST API. Tools listed in `approvalRequiredWriteTools` advertise `requiresApproval: true` so MCP hosts can prompt the user — there is no server-side approval gate.

## `GET /healthz`

- Returns a simple readiness payload for the package-owned server process.
- Does not require authentication.

## `POST /v1/auth/exchange`

- Accepts a Radioso workspace API token plus optional client metadata and requested capabilities.
- Validates the upstream token by making a safe Radioso API call through the package-local adapter.
- Returns a short-lived MCP access token, expiry metadata, and the granted capabilities.
- Never returns the upstream Radioso token.

### Request

```json
{
  "radiosoApiToken": "radioso_example",
  "clientName": "cursor-local",
  "requestedTools": ["search_documents", "answer_grounded", "create_document"]
}
```

### Response

```json
{
  "accessToken": "mcp_sess_...",
  "tokenType": "Bearer",
  "expiresAt": "2026-04-21T12:34:56.000Z",
  "grantedTools": ["search_documents", "answer_grounded", "create_document"],
  "approvalRequiredTools": ["create_document"]
}
```

`approvalRequiredTools` lists tools the host should prompt on. It is informational; the server does not require an approval token before executing them.

## `POST /mcp`

- Remote MCP endpoint using Streamable HTTP semantics.
- Requires a valid MCP access token.
- Tool calls execute as soon as the token-granted session and upstream Radioso permissions allow them. Tools advertised with `requiresApproval: true` are expected to be host-prompted before the host sends the call.
- Supports the documented JSON-RPC smoke flow used in quickstart and tests.

## Error Shapes

- Auth exchange failures return structured JSON errors without secret leakage.
- MCP endpoint failures map to structured JSON-RPC errors for invalid auth, capability-forbidden, unsupported capability, malformed input, and upstream authorization failures.
- Audit logging occurs for both success and denial/error outcomes.
