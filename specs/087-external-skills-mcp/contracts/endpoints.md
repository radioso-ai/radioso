# Phase 1 Contract Notes: External Skills via MCP

Design-time endpoint notes. The authoritative contract is the **code-first OpenAPI registry** at `backend/src/app/http/openapi/document.ts` (Zod schemas). `backend/openapi.yaml` / `backend/openapi.json` are regenerated, never hand-edited. Contract tests accompany each route.

All routes are per-agent and require the existing agent-management authorization (mirror `workspace.agents.manage`-style gating). Secrets are write-only (never returned; masked on read).

## MCP Connections (P1 token; P2 OAuth)

- `GET /agents/{agentId}/mcp-connections` — list (no secrets).
- `POST /agents/{agentId}/mcp-connections` — create `{ displayName, serverUrl, authMethod, accessToken? }`.
- `GET /agents/{agentId}/mcp-connections/{id}` — read (status, masked).
- `PATCH /agents/{agentId}/mcp-connections/{id}` — update (rotate token, rename).
- `DELETE /agents/{agentId}/mcp-connections/{id}` — blocked if referenced by a skill definition (clear error).
- `POST /agents/{agentId}/mcp-connections/{id}/discover` — live `tools/list`; returns discovered tools + input schemas (for the skill builder).
- **P2 OAuth**: `POST .../{id}/oauth/authorize` → returns authorization URL; `GET .../{id}/oauth/callback` → completes consent, stores tokens, sets `authorized`.

## Skill Definitions (P1; outcome fields P3)

- `GET /agents/{agentId}/external-skills` — list defined skills.
- `POST /agents/{agentId}/external-skills` — create `{ skillName, connectionId, toolName, boundParams, exposedParams, declaredOutcomes?, outcomeMap? }`; validated against current discovery.
- `GET /agents/{agentId}/external-skills/{id}` — read.
- `PATCH /agents/{agentId}/external-skills/{id}` — update bindings/outcomes/enabled.
- `DELETE /agents/{agentId}/external-skills/{id}` — remove; report routine references that would break.

## Routine authoring

- Defined skills are surfaced to the routine-authoring picker by `skillName` (reuse existing routine step authoring; no new public routine contract beyond exposing the available skill names + declared outcomes).

## Message-queue / cross-service contract note

No worker/AMQP payload changes. Outbound MCP client is distinct from the inbound MCP server contract (`packages/radioso-mcp-server`), which is unchanged. Re-confirm at implementation.
