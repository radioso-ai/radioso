# API Contract Workflow

Radioso uses the backend OpenAPI document as the source contract for generated client surfaces.

The contract artifacts are:

- `backend/openapi.json`
- `backend/openapi.yaml`
- `typescript-sdk/openapi/radioso.json`
- `typescript-sdk/openapi/radioso.yaml`
- `typescript-sdk/src/generated/types.ts`
- `packages/radioso-mcp-server/src/generated/openapiTypes.ts`

## Update flow

When backend routes, schemas, or response contracts change:

1. Run `pnpm --dir backend run generate:openapi`.
2. Run `pnpm --dir typescript-sdk run sync`.
3. Run `pnpm --dir packages/radioso-mcp-server run sync:openapi`.
4. Run `pnpm run check:api-contracts` from the repo root.
5. Commit the backend contract, SDK snapshot, and MCP generated types together.

The key point is that generated clients should drift only inside one local change. A pull request that changes backend API contracts should include the generated downstream artifacts or fail the contract check.

## Approval decisions

Human approval gates are resolved through an authenticated dashboard command:

```http
POST /api/v1/agents/{agentId}/decisions/{handle}/resolve
```

Request body:

```json
{
  "optionId": "approve",
  "contentHash": "proposal-content-hash",
  "payload": {
    "note": "optional operator context"
  }
}
```

The response is:

```json
{
  "status": "resolved",
  "decision": "approved",
  "conversationId": "conversation-id",
  "resumed": true
}
```

The endpoint is not a chat surface. It records the operator decision and resumes
the suspended routine in one database transaction. Any gated side effect is
enqueued as a routine action and dispatched by the existing outbox worker.

## Contract check

`scripts/check-api-contracts.mjs` compares the backend OpenAPI artifacts with the SDK snapshot and regenerates expected SDK and MCP OpenAPI types in a temporary directory. It fails when committed generated files are stale.

Backend contract tests run this check as part of `pnpm --dir backend run test:contract`.
