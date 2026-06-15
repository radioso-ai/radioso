# Phase 1 Data Model: External Skills via MCP

Scope: per-agent (Assumptions in spec). Secrets are encrypted via `fieldEncryption.ts`; never stored in `skillSettings`.

## Entity: MCP Connection

A reusable pointer to an external MCP server.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| agentId | uuid | FK → agents (per-agent scope) |
| displayName | text | author-facing label |
| serverUrl | text | remote Streamable-HTTP MCP endpoint |
| authMethod | enum(`access_token`, `oauth`) | P1 = access_token; P2 = oauth |
| credentialCiphertext | text (encrypted) | bearer token (P1) or OAuth tokens (P2); via field encryption |
| encryptionKeyId | text | key id for rotation (mirrors existing secret columns) |
| oauthClientCiphertext | text (encrypted), nullable | OAuth client id/secret (P2) |
| status | enum(`unconfigured`,`authorized`,`needs_reauth`,`error`) | lifecycle |
| createdAt / updatedAt | timestamptz | |

**Validation**: serverUrl must be a valid https URL (SSRF policy reuse); `access_token` requires credential; `oauth` requires client + completed authorization before `authorized`. Deleting a connection referenced by a skill definition is blocked or cascades to invalidate dependent skills (decision: block with a clear error).

**State transitions**: `unconfigured` → (credentials/OAuth consent) → `authorized` → (refresh fail) → `needs_reauth`; any → `error` on repeated failures.

## Entity: Skill Definition

A named binding of exactly one discovered tool on one connection.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | PK |
| agentId | uuid | FK → agents |
| connectionId | uuid | FK → mcp_connections |
| skillName | text | unique per agent; the routine `@mention` identifier |
| toolName | text | discovered MCP tool name |
| boundParams | jsonb | fixed input values (e.g. `{channel:"#support"}`) |
| exposedParams | jsonb | spec of conversation-filled inputs; optional `slotBinding` per param |
| outcomeMap | jsonb, nullable | P3: optional declarative result→named-status map |
| declaredOutcomes | text[] , nullable | P3: named outcomes routines may branch on |
| enabled | boolean | default true |
| createdAt / updatedAt | timestamptz | |

**Validation**: `skillName` unique per agent, matches the routine skill-name identifier rules; `toolName` must exist in current discovery for the connection (validated at author time; re-validated/failed-safe at runtime); every bound/exposed param key must exist in the tool's input schema; bound + exposed sets are disjoint and cover required inputs (required inputs must be bound or exposed). `outcomeMap`/`declaredOutcomes` only meaningful when set (P3).

**Relationships**: belongs to one MCP Connection; referenced by routine steps via `skillName`. Many skill definitions may bind the same `(connectionId, toolName)` with different `boundParams`.

## Transient: Discovered Tool (not persisted)

From live `tools/list` on a connection: `{ name, description, inputSchema, outputSchema? }`. Used by the skill builder (schema → param UI) and by author-time/runtime validation. Never stored as source of truth.

## Runtime projection (no new persistence)

At invocation the executor builds the tool call input = `boundParams` merged with conversation-supplied `exposedParams` (LLM-filled against `inputSchema` by default; or via `slotBinding`). Result → `RoutineSkillResult.status`: coarse (`completed`/`failed`) in P1; named outcomes via the outcome interpreter in P3. No raw discovered tool is ever exposed to the model — the set of enabled skill definitions IS the allow-list.

## Export/import (settings-as-data)

Connection (minus secrets) and skill definitions are serializable as agent config data, consistent with the agent-settings-as-data direction. Secrets are excluded and handled by the secret store; on import, OAuth connections require re-authorization.
