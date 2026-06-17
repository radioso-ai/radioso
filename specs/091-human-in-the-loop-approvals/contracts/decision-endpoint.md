# Contract notes — Decision endpoint (operator resume)

Design-time notes. **Runtime source of truth** = the code-first registry `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml`/`.json` are regenerated, never hand-edited. SDK (`typescript-sdk` via `pnpm run sync`) and MCP generated types regenerated. Contract test in `backend/tests/contract/`.

## Route

```
POST /api/agents/:agentId/decisions/:handle/resolve
```
Authenticated as a workspace member (reuses `requireWorkspaceSession`/`requirePermission`). Sibling to `agentRoutes.ts` (which owns authoring CRUD only). **Not** exposed on the public/embed surface in Tranche A.

## Request

```typescript
interface ResolveDecisionRequest {
  optionId: string;     // MUST be one of the pending row's options
  payload?: unknown;    // optional edit/reason, merged under the capture key
  contentHash: string;  // echoed from the proposal; MUST match the stored hash
}
```

## Response

```typescript
// 200 — decision applied and routine resumed
interface ResolveDecisionResponse {
  status: "resolved";
  decision: "approved" | "rejected";
  conversationId: string;
  resumed: boolean;     // engine advanced past the gate
}
```
The endpoint is a **command**, not a chat surface: it returns no turn body. The resumed turn is persisted and read through the normal conversation read path.

## Validation (server-side, in order; first failure short-circuits)

| Check | Rule | Failure |
|---|---|---|
| Exists & open | `loadByHandle(handle).status === 'pending'` | `404` unknown / `409` already resolved |
| Authenticated member | dashboard workspace session (never the chat surface) | `401` |
| Authorized decider | caller satisfies `decider_scope` resolved server-side — independent of any UI affordance | `403` |
| Hash match | `request.contentHash === row.content_hash` (binds to the exact proposal) | `409 stale_proposal` |
| Valid option | `optionId ∈ row.options[].id` | `422` |
| Exactly-once | CAS `UPDATE … WHERE handle=$1 AND status='pending' AND content_hash=$2` resolves one row or no-ops | concurrent 2nd → `409` |

## Effect (one transaction)

1. `pendingDecisionRepository.resolve(...)` records the decision idempotently (CAS) + writes the `hitl.decision` audit event.
2. The host reconstructs the parked `TurnContext` and calls `engine.resumeAwaitingDecision({ turn, decision, suspendedReader, routineRunner })`.
3. The `ConversationRoutineDecisionResult` is persisted exactly like a normal routine turn via `completeAssistantTurn` (assistant message + routine-state advance `suspended→active|completed` version-guarded + emitted actions + trace).

A crash after step 1 never re-prompts the human (the decision is durable); resume on retry is idempotent because the row is no longer `pending`.

## Message-queue / contract impact

- **New outbox action type `approval.request`** (notification only): payload `{ handle, conversationId, agentId, link }` (link carries the handle). Documented in queue docs/tests; handler registered via `registerActionHandler` like `contact.send`; retry/lease semantics reuse the existing claim/lease path **unchanged**; no document-worker dispatch or AMQP payload change.
- **New REST endpoint** + **new `source` field** on message responses → OpenAPI regen + SDK `sync` + MCP `sync:openapi`; both additive/non-breaking.
