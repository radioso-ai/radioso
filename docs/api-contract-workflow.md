---
title: "API Contract Workflow"
description: "Workflow for synchronizing OpenAPI contracts across backend, SDK, and MCP when API routes and schemas change."
last_updated: 2026-07-27
---

# API Contract Workflow

The backend OpenAPI document is the single source contract for every generated client surface. The TypeScript SDK types and the MCP server types are both derived from it, so the backend describes the API once and the downstream clients inherit that description instead of re-declaring it.

Regeneration runs in one direction — backend first, then SDK, then MCP — because each downstream artifact is generated from the one before it. Run the steps out of order and a client can end up generated against a contract the backend no longer serves, which is exactly the drift the contract check is there to catch.

These artifacts move together:

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

Human approval gates can be listed for the signed-in workspace:

```http
GET /api/v1/decisions
```

The response contains pending decisions only, newest first:

```json
{
  "decisions": [
    {
      "handle": "decision-handle",
      "conversationId": "conversation-id",
      "agentId": "agent-id",
      "routineId": "routine-id",
      "stepId": "approval-step-id",
      "reason": "Needs operator review",
      "options": [
        { "id": "approve", "label": "Approve" },
        { "id": "reject", "label": "Reject", "description": "Send back for edits" }
      ],
      "contentHash": "proposal-content-hash",
      "deadline": null,
      "createdAt": "2026-06-01T00:00:00.000Z"
    }
  ]
}
```

The `handle`, `agentId`, `contentHash`, and selected option id are used to resolve
the decision.

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
