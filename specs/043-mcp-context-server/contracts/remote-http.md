# Remote HTTP Contract Notes

The remote MCP package owns these HTTP endpoints. They are package-local contracts, not backend routes.

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
  "radiosoApiToken": "sk_proj_example",
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

## `POST /v1/approvals`

- Requires a valid MCP access token.
- Accepts a reason and one or more governed write tools.
- Returns a short-lived approval token scoped to the current session and allowed tools.

### Request

```json
{
  "reason": "create onboarding doc",
  "tools": ["create_document"]
}
```

### Response

```json
{
  "approvalToken": "mcp_appr_...",
  "expiresAt": "2026-04-21T12:39:56.000Z",
  "approvedTools": ["create_document"]
}
```

## `POST /mcp`

- Remote MCP endpoint using Streamable HTTP semantics.
- Requires a valid MCP access token.
- Tool calls for governed write tools must include an approval token field in the tool arguments or equivalent package-local approval metadata path.
- Supports the documented JSON-RPC smoke flow used in quickstart and tests.

## Error Shapes

- Auth exchange failures return structured JSON errors without secret leakage.
- MCP endpoint failures map to structured JSON-RPC errors for invalid auth, missing approval, unsupported capability, malformed input, and upstream authorization failures.
- Audit logging occurs for both success and denial/error outcomes.
