# Feature Specification: MCP Agent Converse (Scope 1)

**Feature Branch**: `098-mcp-agent-converse`  
**Created**: 2026-06-27  
**Status**: Approved  
**Input**: User description: "We neglected the MCP server. The platform became an agent platform but Radioso-as-an-MCP-server is still a workspace-scoped document store with no concept of an agent. Define a scope-1 'converse' MCP surface so external clients can chat with a specific agent. Scope 2 (admin: create agents, author directives/routines, run evals) is out of scope here and is considered only at the transport layer. Auth must be reconsidered: the converse surface is the MCP sibling of public chat, not of the workspace API token."

> **Background (why now).** The Radioso MCP server (`packages/radioso-mcp-server`) exposes nine workspace-scoped document/retrieval tools and has no concept of an agent. Its `answer_grounded` tool calls the standalone retrieval API on **system defaults**, so it silently ignores every agent's configured retrieval (rewrite/rerank/source-scope/citations) — a quality regression versus chat, embed, and the per-agent API. More fundamentally, it authenticates with a **workspace API token** (an operator god-credential), which is the wrong principal for "let an external client chat with one agent." This spec re-founds the converse surface on the agent model and on the per-agent access-grant + signed-session machinery that **already ships** for public chat.

> **Design source of truth.** The two-scope framing (converse data-plane vs admin control-plane) and the auth reconsideration are recorded design decisions. This spec covers **scope 1 only**. Scope 2 (admin authoring/eval over MCP) is explicitly out of scope and appears here only where the **transport substrate** must not foreclose it.

## User Scenarios & Testing *(mandatory)*

The deliverable is an **agent-scoped MCP surface**: a credential confers exactly "converse with agent X" and nothing else. Stories are sliced so each is an independently shippable increment.

### User Story 1 - Converse with one agent using a per-agent credential (Priority: P1)

A workspace owner issues a per-agent MCP converse credential for a specific agent and hands it to an external MCP client (e.g. a script, a hosted app, or a local Cursor/Claude config). The client connects, the surface binds to that one agent, and the client holds a conversation with the agent's full turn loop — persona, directives, routines, history — by calling a single `ask_agent` tool. The credential cannot use the document-**management** tools/APIs (the legacy `list/get/search/create/update/delete/reprocess_document` surface), cannot reach other agents, and cannot touch workspace settings. (US2 later adds sanitized, read-only, agent-scoped document *resources* — a different, curated read path; the management tools stay denied at every priority.)

Concretely: the owner creates a converse grant for agent "Claudio", receives a launch token, and configures the MCP client with it. The client exchanges the launch token for a short-lived, signed converse session, then calls `ask_agent { message }` and receives the agent's answer (with citations when the agent is configured to show them). A second turn continues the same conversation.

**Why this priority**: This is the whole capability end-to-end with the correct principal and the simplest front door (launch-token exchange, reusing the public-chat session issuer). It proves the reframe — per-agent grant → signed session → agent turn loop — and is demoable on its own. Everything else refines it.

**Independent Test**: Against a test agent, mint a converse grant, exchange the launch token for a session, call `ask_agent` twice in one session, and verify (a) the agent's persona/directives/routines run (parity with `/assistant/chat` for the same agent), (b) the conversation continues across turns, (c) a workspace API token is **rejected** on this path, and (d) the credential cannot use the document-management tools or reach a second agent.

**Acceptance Scenarios**:

1. **Given** a converse grant for agent A, **When** the client exchanges its launch token, **Then** it receives a signed session bound to agent A with a bounded TTL, and no workspace-level authority.
2. **Given** a valid converse session for agent A, **When** the client calls `ask_agent { message }`, **Then** the response is produced by agent A's turn loop (same persona/directives/routines as the in-product chat), not the standalone retrieval path.
3. **Given** a prior turn in a session, **When** the client calls `ask_agent` again in the same session, **Then** the turn continues the same conversation (history is preserved and attributed to that session).
4. **Given** a converse session for agent A, **When** the client attempts any document-**management** tool (the legacy workspace document APIs) or addresses agent B, **Then** the request is denied (the grant authorizes converse with A only).
5. **Given** a `Authorization: Bearer <workspace API token>`, **When** presented on the converse surface, **Then** it is rejected (public/launch credentials and the workspace bearer lane stay separate).
6. **Given** an active converse session, **When** its grant is then revoked, disabled, rotated, or grant-expired, **Then** the very next `ask_agent` request fails (per-request grant re-evaluation, FR-009) — not only once the session TTL lapses; and a fresh exchange against that grant also fails.

---

### User Story 2 - Agent-aware grounded read surface (Priority: P2)

The converse surface also offers a read path that reflects the **agent's** configuration rather than system defaults: an agent-scoped grounded-answer tool and the agent's visible documents exposed as MCP **resources** (the idiomatic MCP primitive for readable content), instead of forcing everything through tools. This is a **read-only, sanitized, agent-scoped** projection — explicitly NOT the legacy document-management tools/APIs denied in US1, which remain denied. P1 denies the management surface; P2 adds only this curated resource read path under the new `agent` role's `public_chat.documents.read.scoped` / `public_chat.retrieval.query` permissions.

**Why this priority**: This fixes the confirmed `answer_grounded`-on-system-defaults regression and gives hosts a read surface that matches every other channel. It is additive to US1 and independently demoable: same agent grant, a grounded-answer tool plus resources.

**Independent Test**: Configure an agent with non-default retrieval (e.g. rerank on, a narrowed source scope, citation display on). Ask the same question through the agent's in-product chat and through the MCP grounded-answer tool; verify the retrieved evidence and citation behavior match. Verify the agent's documents are enumerable/readable as MCP resources and that documents outside the agent's scope are not.

**Acceptance Scenarios**:

1. **Given** an agent with tuned retrieval, **When** a grounded answer is requested over MCP, **Then** the result uses that agent's retrieval configuration (parity with the agent's chat), not system defaults.
2. **Given** an agent's visible documents, **When** the client lists/reads MCP resources, **Then** it sees exactly the documents that agent is permitted to see, and citations are sanitized for the public surface (no internal document/chunk IDs leaked beyond what the agent's citation policy allows).
3. **Given** a grounded answer with citations, **When** the agent's citation display is off, **Then** citations are omitted, matching the agent's configured behavior.

---

### User Story 3 - End-user identity for app-on-behalf integrations (Priority: P2)

An application embeds the agent for **its own end-users** over MCP. The app holds the converse credential and passes a **signed end-user identity** per session, so each end-user gets an isolated conversation, and history, human-takeover ownership, and visitor context all attribute to the right end-user instead of collapsing into a single workspace identity.

**Why this priority**: This is what makes the converse surface usable by multi-tenant embedders rather than only single-user clients. It depends on the signed-identity mechanism from the visitor-context work, so it is sliced after the core surface.

**Dependency**: The signed end-user identity (HMAC → customer scope) from the visitor-context feature (spec 097, branch `visitor-context-awareness`, PR #783). This story MUST confirm that mechanism is merged on the working branch before implementation; it is reused, not rebuilt.

**Independent Test**: With one converse credential, open two sessions carrying two different signed end-user identities; verify the two conversations are isolated (no history bleed), each turn is attributed to its end-user, a human-takeover reply is owned by the correct end-user's conversation, and any host-defined visitor context is injected into the right turn.

**Acceptance Scenarios**:

1. **Given** a converse credential and a signed end-user identity, **When** a session is opened, **Then** the session is scoped to (agent, end-user) and conversation history is isolated per end-user.
2. **Given** two end-user identities under one credential, **When** each converses, **Then** neither can see the other's history.
3. **Given** an end-user identity, **When** a human operator takes over, **Then** ownership and provenance attribute to that end-user's conversation (consistent with operator-message provenance).
4. **Given** a tampered or unsigned end-user identity, **When** a session is requested, **Then** it is rejected.

---

### User Story 4 - OAuth 2.1 front door for public connectors (Priority: P3)

A user connects the agent from a public MCP connector (Claude Desktop, ChatGPT, Cursor remote) using the standard MCP **OAuth 2.1** authorization flow (PKCE, dynamic client registration, protected-resource metadata). Authorization issues the same agent-scoped converse session that the launch-token exchange produces.

**Why this priority**: OAuth is what public connectors expect (the current server admits it is "not a native cloud-connector auth mechanism"). It is an **alternate front door** over the same session issuer and grant principal, so it is additive and can follow the core surface.

**Independent Test**: From a connector supporting MCP OAuth, complete the authorization flow against an agent's converse endpoint and verify it yields an agent-scoped session equivalent to the launch-token path, with refresh working and re-auth required on expiry.

**Acceptance Scenarios**:

1. **Given** an agent's converse endpoint, **When** a connector fetches protected-resource metadata, **Then** it discovers the authorization server and completes a PKCE authorization-code flow.
2. **Given** a completed OAuth authorization, **When** the connector calls `ask_agent`, **Then** it operates on an agent-scoped session identical in authority to the launch-token-exchanged session.
3. **Given** an expired session, **When** the connector refreshes, **Then** it obtains a new session without a full re-authorization (until the refresh credential itself expires/revokes).

---

### Edge Cases

- **Origin is absent (the trap).** MCP clients send no `Origin` header. `accessGrantService.evaluate` skips the origin check when `origin == null` (the #609→#612 scar, confirmed at `accessGrantService.ts:184-190`). The converse surface MUST NOT reuse Origin as its constraint axis; a null Origin MUST NOT widen authority.
- **Embed-token reuse attack.** An embed launch token (public, in website HTML, protected only by Origin) MUST NOT be usable on the converse surface — otherwise the absent Origin bypasses its only constraint. The converse resolver accepts only `mcp-converse`-channel grants (FR-018).
- **Workspace token presented on the converse surface** → rejected (US1 #5).
- **Grant for a deleted/disabled agent** → exchange fails; the surface reports the agent is unavailable without leaking other agents.
- **Concurrent sessions** under one credential (US3) must not share conversation state unless they carry the same end-user identity.
- **Stdio / single-tenant self-host**: the simple workspace-token/stdio path remains for trusted single-tenant self-host only and MUST NOT be reachable on the public converse path.
- **Token rotation** of a grant invalidates the old credential without dropping the grant's identity/history association.
- **Long agent turns** (routines, tool calls): the transport must support streaming/long responses without the session expiring mid-turn.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be Node.js; any UI (grant management) MUST be React.
- Database MUST be PostgreSQL with `pgvector`; reuse the existing `agent_access_grants` table — no new credential store.
- User-facing conversational copy MUST come from the LLM via the agent's turn loop; this feature adds no hard-coded assistant strings.
- Backend development MUST follow TDD: failing tests first.
- Frontend grant-management behavior MUST prefer Playwright; unit tests stay on non-visual logic.
- Secrets MUST stay in `.env`; `.env.example` MUST be updated for any new signing/issuer config; grant tokens remain hashed + encrypted as today.
- Customer data MUST follow least-privilege: a converse credential authorizes exactly one agent's converse + that agent's readable evidence, nothing else.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- The spec MUST identify modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - **Transport** = `packages/radioso-mcp-server` (and/or the merged backend `/mcp` mount). It speaks MCP, holds no domain logic, and reaches Radioso only over HTTP APIs — it MUST NOT import backend modules (preserves standalone deployability).
  - **Authorization/credential validity** = `accessGrantService` (revoked/disabled/expired/constraints) and role→permission in `AccountAccessService`. Grants carry a **role**, not a `scopes[]` array (per the access-grants design); the converse authority is a role, not an inline permission check.
  - **Session issuance & validation** = a **backend** concern (it needs `WORKSPACE_TOKEN_SECRET`, the grant repository, and the turn loop). It reuses the existing `publicChatSession` signed-session issuer, extended to mint/validate agent-converse sessions. No new bespoke token format. The MCP transport NEVER holds the signing secret or imports the issuer module.
  - **Orchestration (the turn)** = the existing agent turn loop behind the chat/assistant service; `ask_agent` is a thin transport adapter over it.
  - **Persistence** = `agent_access_grants` (credentials) and existing conversation/history tables.
  - **Deployment ownership (merged vs standalone)** — *resolves finding 4*: the backend exposes converse **HTTP endpoints** (exchange, per-request session validation, `ask_agent` turn, grounded answer, resources, and the OAuth authorization server). In **standalone** mode the `packages/radioso-mcp-server` process calls these over HTTP (no backend imports, no secret). In **merged** mode the backend `/mcp` mount MAY call the same logic in-process behind the same ports. Either way the contract is the HTTP endpoint, not a shared module.
- **Encapsulation Rule**:
  - The MCP server stays transport-only; it gains no retrieval/turn logic.
  - The grant evaluator stays credential-validity-only; it MUST NOT grow MCP-specific permission decisions.
  - The turn loop stays channel-agnostic; "this is MCP" is provenance metadata, not a branch in the engine.
- **New Seams Required**:
  - A **`channel` column** on `agent_access_grants` (`embed | public-link | mcp-converse`) and a new **`agent` role** (DC-001) granting converse + agent-scoped read, denying docs-management/settings/other-agents; plus `resolveConverseGrant(token)` enforcing `channel = 'mcp-converse'`.
  - An **agent-converse session** variant of the public-chat session issuer, embedding `grantId` + grant version (FR-009), bound to (agent, end-user identity, grant).
  - Backend **converse HTTP endpoints** (grant/session-authed) the standalone MCP server calls and the merged mount may call in-process: (1) **exchange** (grant token → session), (2) **per-request validate** (session → re-evaluated grant), (3) **`ask_agent` turn** — the per-agent equivalent of `/assistant/chat`, NOT the workspace-token route and NOT the standalone retrieval-on-defaults route, (4) **grounded answer** + **document resources** (US2).
  - An **MCP OAuth authorization server** front door (US4) that issues sessions against a grant; principal-agnostic so a future control-plane mount can reuse it.
- **Anti-Goals**:
  - Do NOT expose any scope-2/admin/control tool on this surface (no create-agent, author-directive/routine, eval). Scope 2 may share only the transport substrate, on a separate mount/token class.
  - Do NOT project each agent skill as its own MCP tool; the agent orchestrates its own skills inside the turn. `ask_agent` is the unit.
  - Do NOT reuse the Origin allowlist as the converse constraint axis; do NOT let a null Origin widen authority.
  - Do NOT accept the workspace API token on the converse path; do NOT paste operator credentials into external clients.
  - Do NOT build a second credential or session system; reuse grants + the public-chat issuer.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let a workspace owner issue, label, rotate, and revoke a **per-agent MCP converse credential** bound to exactly one agent.
- **FR-002**: A converse credential MUST be exchangeable for a short-lived, signed **converse session** bound to that agent, with a bounded TTL and refresh/expiry semantics.
- **FR-003**: The converse surface MUST expose an `ask_agent` capability that runs the bound agent's full turn loop (persona, directives, routines, history) and returns its response.
- **FR-004**: `ask_agent` turns within one session MUST continue the same conversation, with history persisted and attributed to that session.
- **FR-005**: The converse surface MUST expose an **agent-aware grounded-answer** capability whose retrieval reflects the bound agent's configuration (rewrite/rerank/source-scope/citation policy), achieving parity with that agent's in-product chat — NOT system defaults.
- **FR-006**: The bound agent's visible documents MUST be exposed as **read-only** MCP **resources**, scoped to what that agent is permitted to read, with public-surface sanitization (no internal document/chunk IDs beyond the agent's citation policy). These resources are distinct from — and do not re-introduce — the legacy document-management tools, which remain denied (FR-007).
- **FR-007**: A converse credential MUST NOT grant access to other agents, to direct document management, or to workspace settings.
- **FR-008**: The workspace API token MUST be rejected on the converse surface; public/launch credentials MUST NOT work as `Authorization: Bearer` (preserve the 062 invariant).
- **FR-009**: Converse sessions MUST embed the issuing `grantId` (and a grant version derived from rotation/`updatedAt`), and the converse surface MUST re-resolve and re-`evaluate` that grant (revoked / disabled / expired / version-mismatch on rotation) on **every MCP request**, not only at exchange. A revoked, disabled, rotated, or grant-expired credential MUST stop existing sessions within one request — see "Session revocation & validity model". This is a deliberate divergence from public chat's stateless signature+TTL verification.
- **FR-010**: The converse surface MUST bind a session to (grant, agent[, end-user identity, OAuth client]) and MUST NOT use Origin as an authority axis; a null Origin MUST NOT widen authority.
- **FR-011**: For app-on-behalf integrations, the surface MUST accept a **signed end-user identity** per session, isolate conversation history per end-user, and reject tampered/unsigned identities.
- **FR-012**: Human-takeover ownership and message provenance MUST attribute to the correct end-user's conversation and mark turns as MCP-originated via first-class session provenance (not the ad-hoc `X-Radioso-Capability-Client` header hack).
- **FR-013**: The system MUST support an **MCP OAuth 2.1** authorization front door (PKCE, dynamic client registration, protected-resource metadata) that issues sessions equivalent to the launch-token exchange.
- **FR-014**: The transport (session issuer + OAuth authorization server + audit + multi-node session store) MUST be principal-agnostic so a future control-plane (scope 2) mount can reuse it without reshaping the converse contract.
- **FR-015**: All converse session exchanges, denials, and turns MUST be auditable without logging raw prompts/completions/retrieved content/credentials.
- **FR-016**: Long agent turns (routines/tool calls/streaming) MUST be supported without the session expiring mid-turn.
- **FR-017**: Documentation MUST be updated: MCP client setup for the converse surface (grant issuance, launch-token exchange, OAuth), and the SDK/docs surfaces that describe MCP.
- **FR-018**: The converse surface MUST accept only grants issued for the `mcp-converse` channel and MUST reject `embed`/`public-link` launch tokens, because those are public, Origin-protected values and MCP carries no Origin to enforce. Converse-channel grants MUST be treated as secrets (never embedded in client-readable surfaces).
- **FR-019**: Session exchange, per-request session validation, OAuth authorization, and the converse turn/answer/resources MUST be **backend-owned HTTP endpoints**. The standalone MCP server MUST reach them only over HTTP (no backend-module imports, no signing secret in the transport); the merged `/mcp` mount MAY invoke the same logic in-process behind the same ports. The contract is the endpoint, not a shared module.

### Key Entities *(include if feature involves data)*

- **Converse grant**: a per-agent `agent_access_grant` carrying an `agent` role on a converse channel; credential (hashed + encrypted), bound to one agent, rotatable/revocable/expirable. Authorizes converse + agent-scoped read only.
- **Converse session**: a signed, short-lived session issued from a converse grant, carrying `grantId` + grant version, bound to (agent, optional end-user identity, optional OAuth client). Carries provenance (MCP-originated). Unlike a public-chat session, its validity is re-checked against the live grant on every request (FR-009).
- **End-user identity**: a signed identifier supplied per session by app-on-behalf integrations; scopes conversation history and visitor context (reused from spec 097).
- **`ask_agent` capability**: the converse tool; a transport adapter over the agent turn loop.
- **Agent document resource**: an MCP resource projection of a document the bound agent may read, with public-surface sanitization.

### Decisions (settled during scoping) and remaining clarifications

- **DC-001 (RESOLVED — one settled decision)**: Converse grants use the existing **`public-launch`** principal kind (the session-exchange-only auth lane — never a bearer lane, which is exactly converse's need), a **new `mcp-converse` channel**, and a **new `agent` role**. There is no reuse of the `public` role: `PUBLIC_CHAT_PERMISSIONS` (`accountAccessService.ts:57-62`: `public_chat.turn.create`, `public_chat.session.read.own`, `public_chat.history.read.own`, `public_chat.feedback.write.own`) covers US1 (`ask_agent` → `public_chat.turn.create`, grounding happens inside the turn) but NOT US2's standalone grounded-answer tool or document enumeration, and `public` is shared by website embed which must not gain those. So the `agent` role is required and is the single answer (the earlier "reuse `public`" phrasing is withdrawn). A new `scopes[]` field stays forbidden by the access-grants design; authority remains role-based. The `agent-api` principal kind exists in the schema but is **unwired** and was a *bearer* lane — not used here.
  - **Security driver for the channel (not cosmetic):** embed launch tokens are effectively **public** (embedded in website HTML) and are protected only by the **Origin allowlist**. MCP clients send **no Origin**, and `accessGrantService.evaluate(grant, {origin: null})` skips the origin check (allow). Therefore the converse surface MUST reject `embed`/`public-link` grants and accept only `mcp-converse`-channel grants, which are origin-independent **secrets**. Without this hard boundary, every embed token in the wild becomes a free origin-bypassing converse credential over MCP. A new `resolveConverseGrant(token)` (peer of `resolvePublicLaunchGrant`) MUST enforce `channel = 'mcp-converse'`.
  - **Schema & code changes required (clean break — no backward compatibility):** This feature changes the grant schema and role permissions; existing MCP clients and old MCP sessions are NOT migrated. Specifically:
    - **DB**: add `agent_access_grants.channel TEXT` with values `embed | public-link | mcp-converse` (default `embed` for existing rows, set explicitly on issue); widen the role CHECK from `('public')` to `('public', 'agent')` (migration `078` currently pins `CHECK (role IN ('public'))` at lines 9 and 23).
    - **Types**: widen `AccessGrantRole` (`accessGrants/domain.ts:2`) from `"public"` to `"public" | "agent"`; add a `channel` field to the grant domain/repository.
    - **Permissions**: add `public_chat.retrieval.query` and `public_chat.documents.read.scoped` to the `PublicChatPermission` union; define `AGENT_CONVERSE_PERMISSIONS = PUBLIC_CHAT_PERMISSIONS ∪ {those two}`; add an `agent` branch to `AccountAccessService.principalRoleAllows` (`accountAccessService.ts:546`) returning membership of that set. The `agent` role still denies workspace settings, document *management*, and other agents.
    - **Defaults/resolution**: `AccessGrantService.defaultRole('public-launch' + channel 'mcp-converse')` → `agent`; `resolveConverseGrant` enforces the channel.
    - **Legacy MCP path**: the existing workspace-API-token MCP (the current 9 document tools) remains available ONLY for trusted local/stdio/self-host mode; it MUST NOT be reachable on the public converse path (FR-008). Whether to remove it from the public path entirely is an implementation cleanup, not a compatibility obligation.
- **DC-002 (CONFIRMED BLOCKED)**: The spec-097 signed-identity mechanism is **not on this branch** (`lisbon-v1`); it exists only on `visitor-context-awareness` (PR #783). US3 MUST wait until 097 merges to `main`. US1/US2/US4 do not depend on it.
- **DC-003 (RESOLVED — server-managed continuity)**: Reuse the existing public-chat session model: the signed session already carries a `publicSessionId` (the conversation handle) and `agentId` (`publicChatSession.ts:9-16`). The converse session **owns** the conversation server-side; `ask_agent` continues it with no client-supplied conversation id (single-conversation clients pass nothing). Reuse the existing **30-day resume-token** mechanism for reconnection after the 12h session TTL. For multi-conversation app-on-behalf usage (US3), each `(credential + signed end-user identity)` exchange yields a distinct session/`publicSessionId`. `ask_agent` MAY echo the conversation id for observability. **Required change:** add `mcp` to the `sourceChannel` enum (today `["anonymous", "website_embed"]`).
- **DC-004 (RESOLVED — agent bound by credential, not URL)**: The agent is selected at **session issuance** from the per-agent grant and carried in the session's `agentId`; tool calls take **no agent parameter** and no URL path segment selects the agent. This prevents an IDOR where a path/param could target an agent the credential does not authorize — the credential is the only agent selector. Serve converse on a single data-plane mount kept distinct from any future control-plane (scope-2) mount. A per-agent URL is permitted only as cosmetic/discovery sugar for OAuth connector configuration (US4), never as an authorization input.
- **DC-005 (RESOLVED — OAuth is phase 2)**: Ship the launch-token exchange (US1) first, reusing the `publicChatSession` issuer directly. OAuth (US4) follows; keep the issuer **front-door-agnostic** (FR-014) so OAuth slots in without reshaping the session contract. OAuth is not MVP-blocking because public connectors can use the manually-exchanged session token until OAuth lands.
- **DC-006 (RESOLVED — session revocation is per-request, not stateless TTL)**: see "Session revocation & validity model" below.

### Session revocation & validity model

Public-chat sessions are stateless (signature + TTL only, `publicChatSession.ts:120`), so a revoked grant would otherwise keep working until the session TTL expires (up to 12h). That is unacceptable for converse credentials, which are real secrets on a higher-sensitivity surface. The converse session therefore is **stateful at validation time**:

- The signed session embeds `grantId` and a **grant version** (rotation counter / `updatedAt`).
- On **every** MCP request, the surface re-resolves the grant by `grantId` and runs `accessGrantService.evaluate` (revoked / disabled / expired) **plus** a grant-version match (a rotation invalidates prior sessions). Failure → the request is rejected and the session is dead.
- This bounds revocation latency to a single request rather than the session TTL. The per-request grant lookup is affordable at converse scale (agents/apps, not mass anonymous web traffic); a short in-process cache (single-digit seconds) MAY be used, capping worst-case staleness to the cache TTL — call this out if used.
- Session TTL stays short (target ≤ the public-chat 12h, likely shorter) as defence in depth; the resume token (DC-003) re-exchanges and is itself subject to the same per-request grant check.

The alternative ("valid until session TTL", stateless like public chat) is explicitly **rejected** for this surface.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A converse credential authorizes exactly one agent: 100% of attempts from a converse credential to reach another agent, manage documents, or read workspace settings are denied.
- **SC-002**: The workspace API token is accepted on the converse surface in 0% of attempts.
- **SC-003**: For an agent with non-default retrieval, MCP grounded answers match the agent's in-product chat on retrieved evidence and citation behavior (parity verified on a fixed evaluation set), versus today's system-default divergence.
- **SC-004**: Under app-on-behalf usage, conversation history bleed between distinct end-user identities is 0 across the test matrix.
- **SC-005**: A null `Origin` never widens authority: regression test proves the converse path does not allow-all on absent Origin.
- **SC-006**: A public MCP connector (OAuth path) can connect to an agent and hold a multi-turn conversation end-to-end without any pre-minted token pasted into config.
- **SC-007**: No raw prompts, completions, retrieved content, or credentials appear in audit/observability output for the converse surface.
- **SC-008**: An embed/public-link launch token is accepted on the converse surface in 0% of attempts (regression-tested), closing the embed-token-reuse path.
