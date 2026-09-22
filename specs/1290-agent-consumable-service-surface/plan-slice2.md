# Implementation Plan: Agent-consumable service surface — slice 2 (US3 + US4 + US5)

**Spec**: `specs/1290-agent-consumable-service-surface/spec.md` (FR-020..FR-024, FR-030..FR-034, FR-040, FR-041; SC-001, SC-005, SC-006)
**Issues**: #1290 (this feature), #1296 (sliding-window abuse control — delivered as slice 1 here, because FR-032's per-agent walk-in budget is its first real consumer)
**Branch**: `agent-consumable-service-surface-v2` off `c2ae26776`
**Already shipped (slice 1, #1292/#1299)**: reply envelope on both doors, routine `exposure`, `AgentToolDescriptor`, `AgentToolCatalogPort`, `GET /api/v1/mcp/converse/tools`, routine invocation as a typed tool. This plan builds on those ports and does not reopen them.
**Out of scope**: US6 (`callerKind`, `ask_agent` description formatter, FR-050..FR-052) and US7 (connect snippet, `llms.txt`, FR-053). Hooks are marked *(hook)*.

## What the code says today (verified)

- **No operator-authored agent description exists.** `agents` has no description column (only `internal_name`, `116_agent_internal_name.sql`, which is operator-only and explicitly never public), and `app/composition/agentToolCatalog.ts` hard-codes `description: null` when it maps `agentRepository.findByIdAndWorkspaceId` into `AgentToolCatalogAgent`. FR-020's card `description` and FR-052's `ask_agent` description both have **no source field**. Slice 2 must add one.
- **No per-agent public identifier exists.** The embed's identifier is `agent.surfaceSettings.websiteEmbed.token` in `agents.output_modes` JSONB (expression unique index, `048_agents.sql:14-19`), minted by `withRotatedTokens` (`agents/services/agentService.ts:261-300`, pure, no audit), and it is a **secret printed in page HTML**. `POST /:agentId/website-embed-token/rotate` (`agentRoutes.ts:763-777`) is the rotate template: `requireSurfaceExtension` → `requireWorkspaceSession` → `workspace.agents.manage`, returns the full agent, emits **no audit event**, and is **not in OpenAPI**.
- **`/.well-known` is a flat, additive mount.** `index.ts:46-56`, `ApiRouteMount = { path: string; createRouter: (deps: AppDependencies) => Router }`; a second `{ path: "/.well-known", ... }` entry mounts alongside `createOperatorMcpDiscoveryRoutes`. The route-policy contract (`backend/tests/contract/api-principal-route-policy.contract.test.ts`) walks `router.stack` and only collects handlers carrying the `markApiPrincipalAuthenticator` symbol — a router that imports none of `requireSession` / `requireWorkspaceSession` / `requireDashboardWorkspaceSession` / `requireApiToken` is invisible to the inventory and needs no policy entry. `requireMcpConverseSession` is itself unmarked, so the whole converse surface is already invisible to it.
- **Converse principal is grant-shaped.** `AgentConversePrincipal` (`modules/settings/contracts/agentConverseSession.ts:3-14`) = `{ workspaceId, agentId, publicSessionId, grantId, grantVersion, sourceChannel: "mcp", sourceOrigin: null, authPrincipal }`. `requireMcpConverseSession` re-validates the whole thing on **every** request. `AgentConverseSessionService.exchange:55-134` resolves a grant, computes `grantVersion = sha256(grantId:tokenHash)`, upserts `agent_converse_session_mappings` (PK `(grant_id, grant_version)`, **FK to `agent_access_grants`**, `163_…sql`) to get a stable `public_session_id`, and signs a `ConverseChatSessionPayload` (`domain/publicChatSession.ts:29-38`, `sourceOrigin: z.null()`). Nothing else is persisted; expiry lives only in the signed token.
- **Abuse control is a fixed window in Postgres.** `AbuseControlPort.enforce(policy): Promise<unknown>` (`modules/security/contracts/abuseControl.ts:52-54`); the service returns `AbuseControlResult` but **throws** `tooManyRequests(msg, { retryAfterSeconds })` on block. The counter is one `INSERT … ON CONFLICT DO UPDATE` in `shared/infra/kysely/sqlHelpers.ts:81-128`: `attempt_count` resets to 1 when `window_started_at <= now - windowMs`. Constructed in `app/server/builders/chat.ts:261`, not in composition.
- **No 429 headers anywhere in the backend.** `errorHandler.ts:58-77` writes `res.status(...).json({ error: { code, message, details } })` and never calls `res.setHeader`. `retryAfterSeconds` reaches the client only inside the body. The audit event `security.rate_limit_enforced` is emitted by `app/http/middleware/rateLimit.ts:114-140`, not by the service — a direct `enforce()` call outside that middleware records nothing.
- **The conversation event bus is in-process only.** `chat/services/publicConversationEventBus.ts`: `InMemoryPublicConversationEventBus`, `Map<conversationId, Set<listener>>`, synchronous fan-out, no buffering, no LISTEN/NOTIFY, no Redis. Publishers: `handoff/operatorReplyService.ts:58` and `builders/chat.ts:926`. On Cloud Run with more than one instance **an operator reply handled by instance A never reaches a listener parked on instance B.**
- **Reading messages after a cursor already has a port.** `chatHistoryService.tailConversation(workspaceId, conversationId, { cursor, limit }, { includeOwnership?, includeLatency? })` → `{ messages: ChatConversationTurn[]; cursor: string | null; ownership? }`, over `messageRepository.listSinceByConversationId` (keyset on `(created_at, id)`, opaque `encodeCursor`). Human vs agent is `message.source === "human_agent"` (`MessageSource` also has `human_agent_on_behalf_of_ai_agent`), **not** `role` — an operator reply is `role: "assistant"`.
- **Timeouts are permissive; the pool is not.** No `server.requestTimeout`/`headersTimeout` is set (Node defaults: 300 s / 60 s); no Cloud Run `timeout` attribute is set (default 300 s), `max_instance_request_concurrency` unset (default 80). But `DB_POOL_MAX = 10` per instance and `DB_STATEMENT_TIMEOUT_MS = 15_000`. A 25 s long-poll is safe on the HTTP side and **must not hold a pool connection**. The realtime module's `REALTIME_DB_POOL_MAX` (default 1, capped 2) is the in-repo precedent for keeping a long-lived runtime off the main pool.
- **Signed identity binds origin unconditionally.** `verifySignedIdentity` (`modules/context-variables/identitySigning.ts:111`) rejects when `payload.origin !== input.boundOrigin`, and `boundOrigin` is required on `VerifySignedIdentityInput`.
- **`docs-portal/content/guides/mcp-server.mdx` is 18 246 raw chars** against `PAGE_INLINE_CHAR_BUDGET = 18_000` (`packages/radioso-mcp-server/src/tools/productDocsTools.ts:16`). `radioso_doc_page` already degrades it to outline-only; anything added makes that worse.
- **`packages/wordpress-companion/radioso-sync.php` (1477 lines) registers no REST routes and no rewrite rules**, and `build-zip.sh` copies exactly `radioso-sync.php` + `README.md`.
- Express's default weak ETag is enabled (nothing calls `app.disable("etag")`), so `res.json` on the card routes satisfies FR-022's `ETag` and `If-None-Match` → 304 **for free**. Only `Cache-Control` is new.
- Coverage map: `backend/tests/unit/operatorCopilot/catalogCoverage.ts`, keyed by OpenAPI `operationId`; exclusions are `neverListExclusion("<boundary>")` from `modules/operatorCopilot/neverList.ts`. `rotateAnonymousChatToken` / `rotateWebsiteEmbedToken` are already `neverListExclusion("secret_rotation")`. The per-agent settings proposal tool is **`propose_agent_setting`** (`tools/agentProposals.ts`), backed by `updateAgent`. There is no `propose_agent_channel`.
- Highest migration: `194_routine_definition_exposure.sql`.

## Design answers (the three questions)

### What does each part know?

- `backend/src/modules/security` — the rate-limit *policy* and the *decision*; the window algorithm; nothing about walk-in, agents, or HTTP.
- `backend/src/app/http/rateLimitHeaders.ts` (new, pure) — how a decision becomes `Retry-After` / `RateLimit-*`. Nothing about who produced it.
- `backend/src/modules/agents` — that an agent has a public identity (`publicId`, `publicDescription`, two flags, an optional walk-in budget override) and how it is minted and rotated. Not: cards, MCP, discovery paths.
- `backend/src/modules/agentDiscovery` (new) — A2A / MCP-server-card / ai-catalog JSON shapes; `publicId` → profile; the public MCP endpoint URL as **injected configuration**. It consumes `AgentToolDescriptor` and knows nothing about routines, slots, or exposure rules.
- `backend/src/modules/settings` (converse session) — that a converse session has an *origin* which can be re-validated. Not: which origin kinds exist beyond the union it declares.
- `backend/src/modules/chat` — how to wait for and read conversation updates behind a narrow port. Not: MCP, sessions, long-poll HTTP mechanics.
- `packages/radioso-mcp-server` — per-agent endpoint paths, the reserved `server-card` path, walk-in exchange, rendering `get_conversation_updates`. Not: card contents (it proxies), ownership semantics, routines.
- Embed launcher / WordPress plugin — the card URL for their agent. Not card contents.

### What ports, to whom?

**`AbuseControlDecision`** — `backend/src/modules/security/contracts/abuseControl.ts` (widens the existing port; `enforce` stops returning `unknown`)
```ts
export interface AbuseControlDecision {
  limit: number; remaining: number; resetAtMs: number; retryAfterSeconds?: number;
}
export interface AbuseControlPort { enforce(policy: AbuseControlPolicy): Promise<AbuseControlDecision>; }
```
Consumers: `app/http/middleware/rateLimit.ts` (headers on allow **and** on block), `audiencePulseRefreshRateLimiter.ts`, `operatorCopilot/expensiveOperationGuard.ts`, the new walk-in limiter.

**`applyRateLimitHeaders`** — `backend/src/app/http/rateLimitHeaders.ts` (new, pure)
```ts
export const applyRateLimitHeaders = (res: Response, decision: AbuseControlDecision): void;
export const applyRetryAfterFromError = (res: Response, error: { statusCode: number; details?: unknown }): void;
```
The second is called from `errorHandler.ts` so **every** 429 — abuse control, `usageLimitExceeded`, and any direct `enforce()` outside the middleware — carries `Retry-After` whenever `details.retryAfterSeconds` is a positive number. The first is called from the rate-limit middleware, which is the only place that holds a decision.

**`AgentPublicIdentity`** — `backend/src/modules/agents/domain.ts` (new fields on `ConversationAgent`)
```ts
export interface AgentPublicIdentity {
  publicId: string | null;               // "ag_" + 22 base64url chars, >= 128 bits
  publicDescription: string;             // operator-authored, public, "" when unset
  agentCardEnabled: boolean;             // publishes the cards
  publicAgentAccessEnabled: boolean;     // walk-in; requires agentCardEnabled
  walkInConversationsPerHour: number | null;  // null = env default
}
```

**`AgentPublicProfilePort`** — `backend/src/modules/agentDiscovery/contracts/agentPublicProfile.ts`
```ts
export interface AgentPublicProfile {
  publicId: string; name: string; description: string | null;
  mcpEndpointUrl: string; documentationUrl: string;
  walkInEnabled: boolean;
  tools: readonly AgentToolDescriptor[];
  revisionPublishedAt: string;
}
export interface AgentPublicProfilePort { load(publicId: string): Promise<AgentPublicProfile | null>; }
```
One port, **three pure renderings**, one file each, each typed by its own registered Zod schema:
`renderA2aAgentCard(profile): A2aAgentCard`, `renderMcpServerCard(profile): McpServerCard`, `renderAiCatalog(profile): AiCatalog`.
The default `AgentPublicProfilePort` is composed in `app/composition/agentDiscovery.ts` from `agentRepository.findByPublicId` + the existing `AgentToolCatalogPort`. **The discovery module never imports anything under `modules/routines`.**

**`AgentConverseOrigin`** — `backend/src/modules/settings/contracts/agentConverseSession.ts` (replaces the flat `grantId` / `grantVersion`)
```ts
export type AgentConverseOrigin =
  | { kind: "grant"; grantId: string; grantVersion: string }
  | { kind: "walk_in"; publicId: string };

export interface AgentConversePrincipal {
  workspaceId: string; agentId: string; publicSessionId: string;
  sourceChannel: "mcp"; sourceOrigin: null;
  origin: AgentConverseOrigin;
  authPrincipal: AuthenticatedPrincipal;
}
export interface AgentConverseOriginVerifier {
  revalidate(origin: AgentConverseOrigin): Promise<{ ok: true; agentId: string; workspaceId: string } | { ok: false; code: string }>;
}
```
`requireMcpConverseSession` and `AgentConverseSessionService.validate` call `revalidate` and **never switch on `kind`**. Two adapters implement it: the existing grant lookup, and a walk-in adapter that re-reads the agent and requires `publicAgentAccessEnabled === true` **and** `agent.publicId === origin.publicId`. `recordSuccessfulUse` takes the principal and no-ops for `walk_in`.

**`ConversationUpdateReader` / `ConversationUpdateWaiter`** — `backend/src/modules/chat/contracts/conversationUpdates.ts`
```ts
export interface ConversationUpdateReader {
  read(input: { workspaceId: string; conversationId: string; cursor?: string; limit: number }):
    Promise<{ messages: ConversationUpdateMessage[]; cursor: string | null; ownership: ChatOwnershipAck }>;
}
export interface ConversationUpdateMessage {
  id: string; author: "agent" | "human"; createdAt: string; text: string;
}
export interface ConversationUpdateWaiter {
  wait(input: { conversationId: string; timeoutMs: number; signal: AbortSignal }): Promise<void>;
}
```
`ConversationUpdateReader`'s default implementation wraps `chatHistoryService.tailConversation(..., { includeOwnership: true })` and maps `source === "human_agent" | "human_agent_on_behalf_of_ai_agent"` → `"human"`, everything else → `"agent"`. **`chatHistoryService.ts` (1483 lines) is not modified** — the port adapts it.

### Dependency direction

`agents` ← `agentDiscovery` (reads agent + `AgentToolCatalogPort`) ← discovery routes / MCP package.
`security` ← `app/http` middleware ← every rate-limited route. `settings` (converse session) depends on an `AgentConverseOriginVerifier` it declares; `app/composition/` supplies the two adapters — the settings module never imports `modules/agents`. `chat` owns the update reader/waiter contracts; the converse route consumes them. Nothing new depends on `conversation-engine` or `conversation-contract`.

## Slices (sequential; each compiles, passes its tests, root `pnpm run lint`, and `lint:dead-code:ci`)

### Slice 0 — Split `mcp-server.mdx` (prerequisite, docs-only)

Move `## Agent converse setup`, `### What ask_agent returns`, and `### Routines as tools` (lines 116–160) out of `docs-portal/content/guides/mcp-server.mdx` into a new `docs-portal/content/guides/agent-converse.mdx` ("Connect a calling agent") — the page FR-060's connect guide grows into. Add `'agent-converse': 'Connect a calling agent'` to `guides/_meta.js` after `'mcp-server'`; add a "Read next" link each way. Leaves `mcp-server.mdx` at ~13 k raw chars, both pages under the 18 000-char parsed budget.

Then: `pnpm --filter @radioso/product-docs run sync` and commit `packages/product-docs/src/generated/`. Verify with `cd packages/radioso-mcp-server && pnpm test` that `radioso_doc_page` returns both pages inline rather than outline-only (add an assertion if none exists). No code change.

### Slice 1 — #1296: sliding window + `Retry-After` / `RateLimit-*` on every 429

Tests first: `backend/tests/unit/security/abuseControlService.test.ts` gains a boundary-burst case (`limit` hits at the end of window N, then hits at the start of N+1 → blocked, not admitted) and a decision-shape case; `backend/tests/unit/http/rateLimitHeaders.test.ts` (new, pure); `backend/tests/integration/rate-limit-headers.integration.test.ts` asserts a throttled public-chat request carries `Retry-After` and the three `RateLimit-*` headers, and that an allowed one carries `RateLimit-*` only.

Files: `backend/src/db/migrations/195_abuse_control_sliding_window.sql` (`ALTER TABLE abuse_control_entries ADD COLUMN previous_attempt_count INTEGER NOT NULL DEFAULT 0`); `shared/infra/kysely/sqlHelpers.ts` (the upsert carries the expiring window's count into `previous_attempt_count` instead of discarding it, and returns it); `modules/security/services/abuseControlService.ts` (admission compares `previous * overlapFraction + current` against `limit`, where `overlapFraction = 1 - elapsedInWindow / windowMs`; returns `AbuseControlDecision` on both paths); `modules/security/contracts/abuseControl.ts` (`enforce` returns the decision); `app/http/rateLimitHeaders.ts` (new); `app/http/middleware/rateLimit.ts` (apply on allow and in the catch before rethrow); `app/http/middleware/errorHandler.ts` (one call to `applyRetryAfterFromError` before the JSON write, both `AppError` branches).

**Why the weighted two-window counter and not the Redis swap #1296 proposes**: the burst is the half FR-032 depends on, and this fixes it for every deployment including OSS-without-Redis, at the same one-row, one-statement write cost. Moving the store to Redis is a performance change with its own env switch, fallback path, and failure mode; it stays open on #1296 and is unblocked by this slice because `AbuseControlRepositoryPort` is untouched. Note that split in the PR body and on the issue.

Docs: `docs/monitoring-alerts.md` — the algorithm and the headers clients should honour. Observability: no new metric (the existing `security.rate_limit_enforced` audit event already covers a block); state that in the PR.

### Slice 2 — Agent public identity: `publicId`, description, flags, rotation (FR-024, FR-030)

Tests first: `backend/tests/unit/agents/agentPublicIdentity.test.ts` (mint is lazy and idempotent; format `^ag_[A-Za-z0-9_-]{22}$`; enabling walk-in without the card is refused; rotation produces a different id); `backend/tests/integration/agent-public-identity.integration.test.ts` (PUT flips the flags and mints once; rotate changes the id and writes an audit event; the unique index rejects a collision).

Files: `backend/src/db/migrations/196_agent_public_identity.sql` — `public_id TEXT`, `UNIQUE INDEX ON agents (public_id) WHERE public_id IS NOT NULL`, `public_description TEXT NOT NULL DEFAULT ''`, `agent_card_enabled BOOLEAN NOT NULL DEFAULT false`, `public_agent_access_enabled BOOLEAN NOT NULL DEFAULT false`, `walk_in_conversations_per_hour INTEGER`; `modules/agents/domain.ts` (`AgentPublicIdentity` on `ConversationAgent` + input type + the `publicAgentAccessEnabled ⇒ agentCardEnabled` invariant); `modules/agents/services/agentPublicIdentity.ts` (new; `mintPublicId()`, `ensureMintedForInput()` — pure, sibling of `withRotatedTokens`, which it does **not** extend because a public id is not a token and must not be minted by the embed's rules); `db/repositories/agentRepository.ts` (columns + `findByPublicId`); `app/http/routes/agentPublicIdentityRoutes.ts` (**new file** — `POST /:agentId/public-id/rotate`; `agentRoutes.ts` is 807 lines and does not absorb it); `app/http/openapi/paths/agentsPaths.ts` + `schemas/agentSchemas.ts`.

**Why a column and not `output_modes` JSON.** The public id is not surface-specific — it keys the cards (slice 3), the walk-in exchange (slice 4), and the embed `<link>` — so it does not belong under a per-surface key, and `AgentSurfaceExtensionRegistry` is for surfaces, not agent-level facts. It is also a lookup key on two unauthenticated hot paths, where a real b-tree unique index beats an expression index on a JSON path; and the repo's own precedent for a scalar agent-level fact is a column (`116_agent_internal_name.sql`).

**Why two flags.** The spec's own edge case requires a card for an agent with walk-in off ("still served… because discovery of 'needs a credential' is itself useful"), and FR-024 mints the id when "discovery **or** walk-in is first enabled". `agentCardEnabled` publishes; `publicAgentAccessEnabled` opens the door. The invariant keeps the UI to one primary switch plus a card-only mode rather than two independent toggles.

**Rotation and live-session invalidation (FR-031a) cost nothing extra**: the walk-in principal carries `publicId`, and the origin verifier compares it to the agent's current `public_id` on every request. Rotating the id, or turning the flag off, kills every live walk-in session on its next call with no session sweep and no table to expire — which is precisely why `publicId`, not `agentId`, is in the principal. Grant-bound sessions are untouched.

Frontend: `frontend/components/dashboard/settings/mcp-channel-card.tsx` (257 lines) gains a `<WalkInAccessSection>` child component (new file) with the two toggles, the public id with copy + rotate (confirm dialog: rotation disconnects connected agents), the public description field, and the per-hour budget. Playwright covers the journey; no markup unit tests.

Copilot: the flags and the description are fields on `PUT /api/v1/agents/:agentId` (`updateAgent`), which `propose_agent_setting` already backs — extend that tool's allowed field list and its descriptor text, no new descriptor. `rotateAgentPublicId` is registered in OpenAPI and recorded in `catalogCoverage.ts` as `neverListExclusion("secret_rotation")` (rotation revokes every live walk-in session; Ray proposes the toggles, not the revocation).

Observability: audit `agent.public_id.rotated` and `agent.public_access.changed` with actor (the existing rotate routes emit nothing — this closes that gap for the new one only). Migration: `db:types` **and** `db:schema` committed together.

### Slice 3 — Discovery cards (US3, FR-020..FR-023)

Tests first: `backend/tests/unit/agentDiscovery/renderA2aAgentCard.test.ts` + `renderMcpServerCard.test.ts` + `renderAiCatalog.test.ts` (pure, from a fixture profile; `securitySchemes` flips with `walkInEnabled`; one `skills[]` entry per descriptor; no workspace id, agent id, or token anywhere in the output — assert by serialising and searching); `backend/tests/contract/agent-discovery.contract.test.ts` (validates a rendered card against the published A2A Agent Card JSON Schema — SC-005); `backend/tests/integration/agent-discovery.integration.test.ts` (200 + `Cache-Control: max-age=300` + a weak `ETag`; `If-None-Match` → 304; unknown / card-disabled / unpublished / deleted all 404 with an identical body).

Files: `backend/src/modules/agentDiscovery/` — `contracts/agentPublicProfile.ts`, `domain/renderA2aAgentCard.ts`, `domain/renderMcpServerCard.ts`, `domain/renderAiCatalog.ts`, `routes.ts`, `README.md`; `app/composition/agentDiscovery.ts` (profile port from `agentRepository.findByPublicId` + `AgentToolCatalogPort`; injects `PUBLIC_MCP_CONVERSE_URL` and the docs URL); `app/http/routes/index.ts` (**one** new mount entry `{ path: "/.well-known", createRouter: createAgentDiscoveryRoutes }`); `app/config/env.ts` + `.env.example` (`PUBLIC_MCP_CONVERSE_URL`, `PUBLIC_AGENT_DOCS_URL`; the backend has no MCP URL today — `mcpUrl` lives only in the frontend's runtime config); `openapi/paths/agentDiscoveryPaths.ts` + `openapi/schemas/agentCardSchemas.ts`.

Paths served by the backend, all `publicId`-scoped, all unauthenticated (no marked authenticator ⇒ no route-policy entry), all source-digest rate-limited through the existing middleware:
`GET /.well-known/agent-card/{publicId}.json`, `GET /.well-known/mcp/server-card/{publicId}.json`, `GET /.well-known/ai-catalog/{publicId}.json`.

Served by the MCP package at the SEP-2127 reserved endpoint-relative path: `GET /mcp/a/{publicId}/server-card`, which proxies the backend document. `packages/radioso-mcp-server/src/http/createHttpServer.ts` grows from three path branches to five — extract the if-chain into `http/resolveMcpRoute.ts` (pure path → route-kind) in the same commit rather than adding two more `if`s.

**Decision — the site-level paths live on the customer's site, not on ours.** `/.well-known/ai-catalog.json` and `/.well-known/mcp/server-card.json` are *site* documents; `api.radioso.ai` hosts thousands of agents and cannot answer them unambiguously. Radioso serves the `publicId`-scoped canonical documents plus the endpoint-relative `server-card` a pure MCP client actually dereferences; the customer's own origin maps the three site-level paths onto them with 302s — automatically via the WordPress plugin, and via a documented nginx/Cloudflare rule for everyone else. This is a deviation from FR-021's literal wording; raise it with the spec author.

FR-023, same slice: `publicChatRoutes.ts:273-285` `embed-config` response gains `agentCardUrl?: string`, present only when `agentCardEnabled` and a `publicId` exist (the response is already `Cache-Control: public, max-age=300` and `Vary: Origin`); `frontend/lib/radioso-embed-launcher.js` gains an `ensureAgentCardLinkInjected()` next to `ensureStylesInjected()` (lines 547-602) using the same id-guarded `document.head.appendChild`, emitting `<link rel="agent-card" type="application/json" href="…">`. The `rel` token is unregistered, so the link is an advisory hint; the authoritative discovery path is `/.well-known`. Playwright asserts the link on the embed fixture page.

WordPress: **new file** `packages/wordpress-companion/radioso-agent-card.php` registering the three rewrite rules + 302s, `require_once`d from `radioso-sync.php` (1477 lines — it absorbs nothing); `build-zip.sh` changed to copy `*.php`; a `tests/agent-card-test.php` alongside `status-test.php`.

Docs: `docs-portal/content/guides/agent-converse.mdx` (discovery section + the manual redirect rule), `docs/mcp-client-setup.md`, then `product-docs` sync.
Observability: counter `agent_discovery_card_requests_total{kind, outcome}` where `kind ∈ a2a|server_card|catalog` and `outcome ∈ served|not_found|not_modified` — **no agent id or public id labels**; card 404s at `debug`.

### Slice 4 — Walk-in access (US4, FR-030..FR-034)

**Decision — public id + flag, reusing the existing exchange; not RFC 7591 dynamic client registration.** The converse *session* is already the security boundary: `requireMcpConverseSession` re-validates on every request, and walk-in needs a different **issuer** of that session, not a second session path. DCR would add a client registry table, client id/secret lifecycle, an anonymous grant type on an authorization server whose every existing flow has a dashboard consent step, a second token audience, and introspection on the converse surface — roughly a module — and the anonymous `client_id` it hands out is exactly as strong as the public id. What we give up: OAuth-capable MCP clients that auto-discover `/.well-known/oauth-protected-resource` will not self-configure. In practice that costs little, because a walk-in endpoint accepts **no** credential, so a client that sends no `Authorization` header succeeds. The upgrade path stays open — `securitySchemes` in the card is data, and the principal's origin is a union — and the trigger to take it is per-caller attribution or per-client revocation, neither of which this spec asks for.

Tests first: `backend/tests/unit/settings/agentConverseOriginVerifier.test.ts` (grant adapter unchanged; walk-in refused when the flag is off, when the id does not match, and when the agent is gone); `backend/tests/unit/settings/converseSessionPayload.test.ts` (a legacy flat-grant payload still parses); `backend/tests/integration/walk-in-converse.integration.test.ts` (AS-1..AS-5: exchange with no secret → session + fresh conversation; flag off → refused with the same body an unknown id gets; per-agent budget → 429 with `Retry-After` + `RateLimit-*`; `signedIdentity` bound to `publicSessionId` sets `verifiedCustomerId`; a mismatched binding falls back to anonymous with no error).

Files: `modules/settings/contracts/agentConverseSession.ts` (the origin union, `AgentConverseOriginVerifier`); `modules/settings/domain/publicChatSession.ts` (`converseChatSessionPayloadSchema` becomes a union on `origin.kind`, **with a legacy branch that maps flat `grantId`/`grantVersion` → `{ kind: "grant" }`** so sessions signed before the deploy keep working — kept exactly one release, then dropped, per the repo's precedent); `modules/settings/services/agentConverseSessionService.ts` (206 lines; `exchange` gains a `{ publicId }` input branch and delegates re-validation to the verifier — extract the two issue paths into `converseExchangeOrigins.ts` if the file passes 300 lines); `app/http/schemas/mcpConverseSchemas.ts` (`{ launchToken } | { publicId }`, exactly one required); `app/http/middleware/mcpConverseWalkInRateLimiter.ts` (new); `app/composition/` (both verifier adapters); `app/config/env.ts` + `.env.example` (`MCP_WALK_IN_RATE_LIMIT_WINDOW_MS` default `3_600_000`, `MCP_WALK_IN_SOURCE_RATE_LIMIT_MAX_ATTEMPTS` default 20, `MCP_WALK_IN_AGENT_RATE_LIMIT_MAX_ATTEMPTS` default 60); `modules/context-variables/identitySigning.ts` (`boundOrigin?: string | null`; the origin comparison runs only when a bound origin is supplied — FR-033); `mcpConverseRoutes.ts` (wire the limiter).

**Walk-in sessions do not touch `agent_converse_session_mappings`.** That table is FK'd to `agent_access_grants` and exists to give one credential a *stable* conversation across exchanges; FR-031 wants a *fresh* conversation per walk-in exchange, so `publicSessionId = randomUUID()` and nothing is persisted. No migration in this slice.

**Per-agent budget**: two `enforce` calls, scopes `mcp.converse.walkin.source` (subject = source digest) and `mcp.converse.walkin.agent` (subject = agent id, `limit = agent.walkInConversationsPerHour ?? env`, `windowMs = 1 h`). Both run **before** the exchange resolves anything about the agent's existence, so a throttle leaks nothing. The 429 headers come from slice 1 with no route-level code. The existing `security.rate_limit_enforced` audit event fires because the walk-in limiter is built on `createRateLimitMiddleware`.

FR-034 needs no plumbing: `UsageLimitPolicy.reserveAnswer` already runs for `sourceChannel = "mcp"` via `chatAnswerUsageKind` → `conversation_reply`. Verify with an assertion in the integration test rather than new code.

MCP package: `resolveMcpRoute` gains `/mcp/a/{publicId}`, which exchanges a walk-in session on first contact and binds it to the transport exactly as a bearer-bound session is bound today (`auth/authService.ts`, `http/sessionServerManager.ts` — the per-request transport isolation from `fa301ce28` already makes this safe). `/mcp` keeps working unchanged for credential-bound clients. The per-agent endpoint path is what makes both the SEP-2127 relative `server-card` and a credential-free connect work from one URL.

*(hook, US6)* AS-1's `callerKind = "agent"` and FR-034's `callerKind` on usage rows are FR-050 work. This slice creates walk-in conversations through the unchanged converse path and does **not** stamp `callerKind`; the exchange is where US6 will set it.

Docs: `docs/mcp-client-setup.md` (walk-in connect, no credential), `docs/operator-mcp.md` (the boundary: operator MCP is unchanged), `agent-converse.mdx` (walk-in security notes: what a public id is and is not), product-docs sync.
Observability: `mcp_converse_walk_in_exchanges_total{outcome}` where `outcome ∈ issued|disabled|throttled|unknown`; refusals logged at `info` with the source digest and agent id; no public id in logs or metric labels.

### Slice 5 — Resumption (US5, FR-040, FR-041)

Tests first: `backend/tests/unit/chat/conversationUpdateReader.test.ts` (`source === "human_agent"` → `author: "human"`; `human_agent_on_behalf_of_ai_agent` → `"human"`; everything else → `"agent"`; ownership defaults to `ai_owned`); `backend/tests/unit/chat/conversationUpdateWaiter.test.ts` (resolves on a bus event; resolves on the poll tick with no bus event — the multi-instance case; resolves at the deadline; an aborted signal clears every timer and unsubscribes); `backend/tests/integration/converse-messages.integration.test.ts` (AS-1..AS-3 and SC-006: forced handoff → operator reply → the long-poll returns it with `author: "human"`; `waitMs: 0` returns immediately; a revoked grant is refused).

Files: `modules/chat/contracts/conversationUpdates.ts` (new); `modules/chat/services/conversationUpdateReader.ts` (new; adapts `tailConversation`); `modules/chat/services/conversationUpdateWaiter.ts` (new); `app/http/routes/mcpConverseMessagesRoute.ts` (new; `mcpConverseRoutes.ts` composes it); `app/http/schemas/mcpConverseSchemas.ts`; `openapi/paths/mcpConversePaths.ts` + a `ConverseMessagesResponse` schema; `app/composition/` (wire the waiter over the existing `publicConversationEventBus`).

**Decision — a narrow waiter port, not the event bus directly, and the wait is a race, not a subscription.** `InMemoryPublicConversationEventBus` is per-process and unbuffered, so subscribing alone would silently fail whenever the operator's reply lands on another Cloud Run instance — the exact scenario US5 exists for. `createConversationUpdateWaiter({ bus, pollIntervalMs })` races three things: the bus (fast path, sub-millisecond in the single-instance and local cases), a jittered `setTimeout` ladder at `pollIntervalMs` (default 2 000 ms) that simply wakes the handler to re-query, and the deadline. Correct across instances, no new infrastructure, and the bus stays exactly what it is.

**Why this is safe against the request timeout and the pool.** A 25 s wait sits far inside Node's default 300 s `requestTimeout` and Cloud Run's default 300 s service timeout, neither of which this change needs to touch; `headersTimeout` (60 s) governs request headers, not the response. The wait itself holds **no** Postgres connection — each re-query is a short keyset read that returns its connection immediately, so `DB_POOL_MAX = 10` is not consumed by parked callers (Cloud Run's default concurrency is 80, so parked requests cost sockets, not connections), and nothing blocks long enough to meet `DB_STATEMENT_TIMEOUT_MS = 15_000`. Worst case per waiting caller is ⌈25/2⌉ = 13 trivial reads. The handler aborts the waiter on `req.on("close")`. The read budget is charged once per call through a new `mcp.converse.messages.session` scope, never per poll tick.

**Decision — the cursor is opaque, not a message id.** `messageRepository.listSinceByConversationId` keysets on `(created_at, id)`; a bare message id cannot seek without its timestamp. The route takes `?cursor=<opaque>` and returns the next `cursor`; the MCP tool argument is `cursor?`. This deviates from FR-040's `since=<messageId>` and US5's "last seen message id" — raise it with the spec author.

MCP package: `tools/conversationUpdatesTools.ts` (new) rendering `get_conversation_updates({ cursor?, waitMs? })`; the name is already in slice 1's reserved list, so no routine can have taken it. `converseApiAdapter.ts` gains the typed call from the regenerated `src/generated/openapiTypes.ts`.

Docs: `agent-converse.mdx` resumption section, `docs/mcp-client-setup.md`, `docs/human-takeover.md` (an agent caller can come back for the reply), product-docs sync.
Observability: `mcp_converse_update_polls_total{outcome}` where `outcome ∈ immediate|woken|deadline`; per the spec, long-poll waits are **not** spans.

## Contract-change review

- **OpenAPI**: additive except one narrowing — the converse exchange body becomes `{ launchToken } | { publicId }` (existing bodies stay valid). New operations: three `/.well-known/*` card reads, `rotateAgentPublicId`, `getMcpConverseMessages`. `updateAgent` gains five optional agent fields. Regenerate `backend/openapi.{json,yaml}`, `cd typescript-sdk && pnpm run sync`, `cd packages/radioso-mcp-server && pnpm run sync:openapi` in the same change; CI fails on either snapshot drifting.
- **Ports**: `AbuseControlPort.enforce` narrows `unknown` → `AbuseControlDecision` (all four in-repo call sites updated in slice 1). `AgentConversePrincipal` replaces two flat fields with a union; the *wire* payload accepts both shapes for one release.
- **Message queue / worker: no change.** Every new path is synchronous on the API process. Cards read the published revision snapshot, walk-in creates a conversation through the existing converse path, and the long-poll waits in-process. No AMQP payload, no document-worker dispatch, no retry semantics, no queue docs or tests are affected.
- **Engine contract** (`@radioso/conversation-contract`): unchanged.
- **Infra**: two new backend env vars plus three limiter settings need Terraform wiring in both region stacks before the walk-in surface is usable; `PUBLIC_MCP_CONVERSE_URL` is the one that breaks cards if unset (the card route 500s rather than emitting a wrong URL — assert that in the integration test).

## Files that must not grow

| File | Lines | Disposition |
|------|-------|-------------|
| `frontend/lib/radioso-embed-launcher.js` | 2395 | Add one ~15-line named function; the file is long past extraction threshold — flagged, extraction out of scope here |
| `backend/src/modules/chat/services/chatService.ts` | 1856 | Not touched |
| `backend/src/modules/chat/services/chatHistoryService.ts` | 1483 | Not touched; `ConversationUpdateReader` adapts `tailConversation` |
| `packages/wordpress-companion/radioso-sync.php` | 1477 | New `radioso-agent-card.php`; `build-zip.sh` copies `*.php` |
| `backend/src/app/http/routes/publicChatRoutes.ts` | 914 | One field on `embed-config`; propose the `tail`/`events`/`history` trio → `publicChatConversationReadRoutes.ts` as a separate extraction-only commit if it is touched again |
| `backend/src/app/http/routes/agentRoutes.ts` | 807 | Rotation goes in a new `agentPublicIdentityRoutes.ts` |
| `packages/radioso-mcp-server/src/http/createHttpServer.ts` | 182 | Extract `resolveMcpRoute.ts` in slice 3 before adding the fourth and fifth path |

## Decisions

1. **Walk-in = public id + flag** (slice 4 rationale). DCR stays available; the trigger to take it is per-caller attribution or per-client revocation.
2. **One principal, discriminated origin, verified through one port.** `requireMcpConverseSession` never branches on `kind`; the two adapters do. This is what keeps FR-031a free.
3. **`publicId` is a column**, `ag_` + 22 base64url chars, minted lazily on first enable, rotatable, and invalidating by comparison rather than by sweep.
4. **Two flags** (`agentCardEnabled`, `publicAgentAccessEnabled`) with `publicAgentAccessEnabled ⇒ agentCardEnabled`, because the spec requires a card for a credential-only agent.
5. **One profile port, three pure renderings.** The discovery module consumes `AgentToolDescriptor` and never imports `modules/routines`.
6. **Site-level `/.well-known/ai-catalog.json` and `/.well-known/mcp/server-card.json` live on the customer's origin**, not on `api.radioso.ai`; Radioso serves `publicId`-scoped canonicals and the endpoint-relative `server-card`. Spec deviation — flagged.
7. **#1296 lands as the algorithm fix plus headers; the Redis store stays open on the issue.**
8. **Headers in two places only**: the rate-limit middleware (it holds a decision) and the error handler (it sees every 429). No route sets a header.
9. **Long-poll = bus race + bounded re-poll**, because the bus is per-process.
10. **Opaque cursor, not a message id.** Spec deviation — flagged.
11. **A new `publicDescription` field is required.** The spec assumes an operator description exists; no such field does, and the catalog hard-codes `null`. It ships in slice 2 because both the card (FR-020) and US6's formatter (FR-052) need it.

## Verification per slice and merge gates

- Backend: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` **and** the test tsconfig; targeted `pnpm exec vitest run <files>`; then `pnpm run test:unit`, `pnpm run test:contract` (regenerate OpenAPI first), `pnpm run test:integration` (slices 1, 2, 4, 5; disposable DB per `packages/integration-test-support`).
- Packages: `cd packages/radioso-mcp-server && pnpm run build && pnpm test` (slices 0, 3, 4, 5) and `pnpm run smoke:all` against a running backend (slices 4, 5).
- Frontend: `cd frontend && pnpm test`; Playwright for the Channels → MCP walk-in journey (slice 2) and the embed `<link>` (slice 3). WordPress: `packages/wordpress-companion/tests`.
- Repo root after every slice: `pnpm run lint`, then `pnpm exec tsc` in every touched package (the `no-unnecessary-type-assertion` autofix trap), then `pnpm run lint:dead-code:ci`.
- Snapshots: after each migration, `db:types` **and** `db:schema` committed together; after slices 2–5, `backend/openapi.{json,yaml}`, `typescript-sdk/openapi/*` + `src/generated/types.ts`, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts` regenerated and committed; after any `docs-portal/content` edit, `pnpm --filter @radioso/product-docs run sync` (four CI checks go red without it).
- Copilot: `catalogCoverage.ts` has an entry for every new `operationId` — `propose_agent_setting` covers the flags and the description; `rotateAgentPublicId` is `neverListExclusion("secret_rotation")`. `assertCopilotCapabilityProvenanceRegistry` must stay green. The deterministic copilot eval suite runs after slice 2.
- SC checks: SC-005 is the contract test validating a rendered card against the A2A schema; SC-001 and SC-006 are Playwright/integration end-to-end runs added in slices 4 and 5. SC-003 remains a US6 follow-up.
- Merge gates: PR title in Conventional Commits; deterministic eval suite green (no routine fixtures change here, so no baseline re-record is expected — if one is, stop and explain why); SDK and MCP snapshot jobs green.

## Contradictions to raise with the spec author

- **FR-020 / FR-052 assume an operator agent description.** No such field exists; `agentToolCatalog` composition returns `null`. Slice 2 adds `publicDescription`.
- **FR-031's `callerKind = "agent"` and FR-034's `callerKind` on usage rows are FR-050 (US6) work**, which the spec puts in a later story than the one that asserts them.
- **FR-021's site-level paths cannot be served multi-tenant** from the API host; decision 6 relocates them.
- **FR-040's `since=<messageId>`** is not seekable against the existing keyset cursor; decision 10 uses the opaque cursor.

## Implementation notes (slice 3, as built)

- **An agent's endpoint is `${PUBLIC_MCP_CONVERSE_URL}/a/{publicId}`**, and `PUBLIC_MCP_CONVERSE_URL` is the MCP endpoint base (`https://mcp.example.com/mcp`). Slice 4 must serve `/mcp/a/{publicId}` at that path; `resolveMcpRoute` already returns `not_found` for it, with the server-card branch beside it.
- **The A2A card is the v0.3.0 shape** (`url`, `protocolVersion`, `preferredTransport: "MCP"`, `securitySchemes`, `security`, `skills`), gated against `specification/json/a2a.json` from tag `v0.3.0`, vendored under `backend/tests/fixtures/discovery-schemas/`. A2A v1 renames `url` to `supportedInterfaces` and its published bundle sets `additionalProperties: false`, so the two shapes cannot both validate; revisit when clients follow.
- **`securitySchemes` does not flip with walk-in; `security` does.** A2A's scheme union has no `none` member, so FR-020's "`none` iff walk-in enabled" is rendered as an empty security requirement `{}` — OpenAPI's and A2A's way of saying "no credential" — listed ahead of `{ bearer: [] }`. `securitySchemes` is `{ bearer }` in both states.
- **The MCP server card follows the published MCP server document schema** (`static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`, also vendored), which bounds `description` to 100 characters and requires a reverse-DNS `name` — rendered as `ai.radioso/{publicId}`. Walk-in state and the tool names ride in `_meta["ai.radioso/agent"]`.
- **FR-023's card URL is built from `CONNECTOR_PUBLIC_BASE_URL`**, the existing public API origin, rather than a third new env var; `agentCardUrl` is absent from `embed-config` when it is unset.
- **The discovery module imports `AgentToolDescriptor` type-only from `modules/routines/public.js`**, the sanctioned boundary — the alternative was a duplicated structural type. It reaches nothing else under `modules/routines`.
- **`agentPublicProfile` is an `AppDependencies` port**, because the profile needs the current published revision (for `version`, `publishedAt`, and the unpublished 404) and the revision runtime reader is not otherwise on `AppDependencies`.

## Implementation notes (slice 4, as built)

- **The exchange input is a union with a shared context**, `AgentConverseSessionExchangeInput = ({ launchToken } | { publicId }) & { client?, sourceDigest? }`. `sourceDigest` travels into the service because the walk-in outcome counter and its `info` refusal log name the caller, and only the HTTP edge can resolve a digest. The route reads it from `res.locals`, where the walk-in limiter puts the one it already computed, so the two never disagree.
- **`recordSuccessfulUse` takes `Pick<AgentConversePrincipal, "origin">`** rather than the old `Pick<…, "grantId">`, and no-ops for `walk_in`.
- **The grant path's validation audit moved into the grant verifier adapter**, which is the only place that still holds the `AccessGrant` the audit metadata is built from. `AgentConverseSessionService.validate` keeps only the `invalid_session` audit, before an origin exists.
- **`agentChannelChatRateLimiter` keyed turns on `principal.grantId`, so a walk-in session would have bypassed both the per-caller and the workspace turn budgets.** It now resolves a `callerKey` — `grant:<id>` or `walkin:<publicSessionId>` — which is what makes FR-032's "exchanges **and turns**" true for walk-in.
- **`createMcpConverseTokenRateLimiter` skips a body with no `launchToken`.** Left alone it spent the token bucket under the digest of the empty string for every walk-in caller alike.
- **The legacy flat-grant payload branch was needed and is covered** by `tests/unit/settings/converseSessionPayload.test.ts`, which hand-signs a token in the previous shape. Drop the branch, the transform, and that test one release after this ships.
- **MCP package continuity uses the protocol's own `Mcp-Session-Id`.** A walk-in caller presents no bearer token, so there is no store key; keying on the public id alone would merge every caller of an agent into one conversation, and keying on the source digest would merge everyone behind a NAT. The server mints a handle on first contact, returns it, and stores the session under `radioso-walk-in:{publicId}:{handle}`. The stateless transport (`sessionIdGenerator: undefined`) ignores an inbound `mcp-session-id`, so owning the header at the HTTP layer is safe. A client that does not echo it gets a fresh conversation per call — degraded, never another caller's conversation. Worth stating in US7's connect snippet.
- **`requestHandler.ts` grew two exports**, `refuseUnservableMcpRequest` and `withMcpAcceptHeader`, so the walk-in door runs the same readiness and bounded-client-metadata guards without a second copy.
- **`boundOrigin` is `string | null | undefined` on `VerifySignedIdentityInput`** and the origin comparison runs only when one is supplied. Public chat still passes `sourceOrigin` and returns early when it has none, so its behaviour is unchanged.
- **No new `operationId`**: `createMcpConverseSession` and `askMcpConverseAgent` are already `endUserSurface` entries in `catalogCoverage.ts`, and `fieldParity.ts` only covers operations a copilot tool backs, so neither gate needed an entry.
