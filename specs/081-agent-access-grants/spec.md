# Feature Specification: Agent Access Grants (Token Authorization Phase 2)

**Feature Branch**: `081-agent-access-grants`
**Created**: 2026-06-06
**Status**: Approved (2026-06-06)
**Input**: User description: "Re-think the channels. Each channel has settings that are unique but shouldn't be — embed allow-list, API admin token, MCP access. The underlying access is the same; unify it. Decisions: grants bind per agent (only the admin API token stays per-workspace); unify the scope model; origin-only allow-list with an allow-all option."

> Builds directly on `062-multiple-role-tokens` (Token Authorization Phase 1), which modeled
> authenticated callers as explicit principals, preserved the existing workspace token as an
> admin workspace API token principal, and **explicitly deferred** to a follow-up: multiple
> tokens per workspace, token-management UI, productized role selection, and fine-grained
> custom scopes. This spec is that follow-up. Design note: `.context/access-grants-design-note.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One credential model behind every channel (Priority: P1)

As an operator, I want every way an agent is reached — website embed, public chat link, agent
REST API, agent MCP — to share one access-grant model, so that the same lifecycle (issue,
rotate, revoke, last-used) and the same constraints apply everywhere instead of four
inconsistent half-implementations.

**Why this priority**: This is the substrate change. Until the credential is unified, every
other improvement (scopes, allow-lists, independent revocation) has to be built four times.
It also closes a real gap: today the public-surface (embed / public chat) tokens are plaintext
with no revocation or last-used, while the API token is hashed and revocable.

**Independent Test**: Issue a grant for an agent surface, rotate it (old value stops working,
new value works), revoke it (value stops working, is not silently re-minted), and confirm
last-used advances on a successful call — for an embed grant and an API grant alike.

**Acceptance Scenarios**:

1. **Given** an agent with a website-embed grant, **When** the grant is revoked, **Then** the
   embed launch credential is rejected and no new credential is minted in its place.
2. **Given** any agent access grant, **When** it authenticates a request successfully, **Then**
   its last-used timestamp advances.
3. **Given** a rotated grant, **When** the previous credential value is presented, **Then** it
   is rejected and the new value is accepted.
4. **Given** an existing embed/public-chat token from before this change, **When** the system
   upgrades, **Then** it is preserved as an equivalent agent access grant with no loss of access.

---

### User Story 2 - Access by role through the existing permission module (Priority: P1)

As a security-minded operator, I want a grant's access decided by a **role** resolved through the
one existing access module (`AccountAccessService`), not by a scope array the grant carries or by
which route it happens to reach. A new **`public` role** holds the minimal necessary permissions
for launch credentials; later roles (`member`, agent-api) are added as role→permission mappings in
the same module.

**Why this priority**: 062 already models access as role → permission set (`workspace_api_token`
roles via `tokenRoleAllows`; `public_chat_session` via `PUBLIC_CHAT_PERMISSIONS`). The grant must
reuse that, not fork a second permission path. A grant is a **credential** (identity + lifecycle +
origin constraint + role); it must not know how to decide permissions. This keeps one source of
truth and lets MCP/agent-api roles be added centrally without per-grant arrays.

**Independent Test**: Resolve a `public`-role grant; confirm its principal is allowed exactly the
existing public-chat permission set via `requirePermission` and denied everything else, with no
permission logic living in the grant entity or a grant `evaluate()` method.

**Acceptance Scenarios**:

1. **Given** a `public`-role grant, **When** its principal is checked against a public-chat
   permission, **Then** `AccountAccessService` allows it via the role→permission mapping (the same
   `PUBLIC_CHAT_PERMISSIONS` source, not a copy on the grant).
2. **Given** the same grant, **When** checked against a non-public permission (document-write,
   settings-manage), **Then** it is denied by the role mapping — no grant-local scope array involved.
3. **Given** the grant entity and its credential service, **When** code is reviewed, **Then** there
   is no `scopes[]` field on the grant and no permission-membership decision outside
   `AccountAccessService`; the credential service only validates revoked/disabled/expired/origin.
4. **Given** a workspace admin token, **When** it calls any capability, **Then** access continues
   to follow the existing admin role model from 062, unchanged.

---

### User Story 3 - Unified origin allow-list with an allow-all option (Priority: P1)

As an operator embedding an agent, I want one origin allow-list model usable on any
browser-reachable surface, including an explicit "allow all origins" choice, so that origin
restriction is a property of the grant rather than a one-off feature of the embed widget.

**Why this priority**: The allow-list exists only on website embed today. Generalizing it is
low-risk (origin-only, no IP/CIDR) and removes the most obvious "this setting shouldn't be
channel-specific" instance the user called out.

**Independent Test**: Configure a grant with an explicit origin list and confirm a matching
origin is admitted and a non-matching one is rejected; switch the grant to allow-all and confirm
any origin is admitted; confirm an empty list (allow-none) rejects all.

**Acceptance Scenarios**:

1. **Given** a grant with origin list `[https://a.example]`, **When** a request originates from
   `https://a.example`, **Then** it is admitted; from `https://b.example`, **Then** it is rejected.
2. **Given** a grant set to allow-all origins, **When** a request originates from any origin,
   **Then** the origin check admits it (other grant constraints still apply).
3. **Given** a grant with an empty origin list, **When** any origin is presented, **Then** it is
   rejected (empty = allow-none, distinct from allow-all).
4. **Given** the website-embed widget which omits the `Origin` header (same-origin to the API
   proxy), **When** it exchanges a public session, **Then** matching uses the session's bound
   origin, not the live `Origin` header (preserve #609→#612 behavior).

---

### User Story 4 - Public launch credentials stay out of the bearer path (Priority: P1)

As a security reviewer, I need the unified model to preserve the 062 invariant that public chat
and website-embed launch credentials can never act as bearer API/MCP tokens, even though they now
share storage and lifecycle with API grants.

**Why this priority**: Unifying the credential *lifecycle* must not unify the *auth lane*. This is
a hard regression boundary inherited from 062 and must be restated, not assumed.

**Independent Test**: Take a public-launch agent grant and present it as `Authorization: Bearer`
on agent REST and MCP endpoints; confirm authentication fails while it still works on the public
session-exchange endpoints.

**Acceptance Scenarios**:

1. **Given** a public-launch grant, **When** presented as a bearer token to any REST/MCP endpoint,
   **Then** authentication fails.
2. **Given** an agent-API grant, **When** used on a public session-exchange endpoint, **Then** it
   is not treated as a public launch credential.
3. **Given** any grant, **When** it targets an agent outside its bound agent (or a workspace
   outside its bound workspace), **Then** access is denied without enumeration.

---

### User Story 5 - Multiple grants per agent with management UI (Priority: P2)

As an operator, I want to issue more than one grant per agent surface (e.g. staging vs production
embed keys, a partner's read-only API grant) with a label and an enable toggle, and revoke them
independently, so access management is productized rather than a single rotatable secret.

**Why this priority**: Delivers the operator-facing value but depends on P1's grant model. Slicing
it separately keeps the substrate change shippable on its own.

**Independent Test**: Create two labeled grants on one agent, disable one, confirm the disabled
one is rejected while the other works, and revoke one without affecting the other.

**Acceptance Scenarios**:

1. **Given** an agent, **When** two labeled grants are issued for the same surface, **Then** both
   authenticate independently and appear in the management view with their labels and last-used.
2. **Given** two grants, **When** one is revoked or disabled, **Then** the other continues to work.
3. **Given** a grant secret, **When** it is first issued, **Then** it is shown once and stored only
   as a hash thereafter.

---

### Edge Cases

- A grant is revoked mid-session for an active public chat — the issued session continues under
  existing public-session rules, but new launches/exchanges with the revoked credential fail.
- The per-workspace admin token is used to reach an agent-scoped capability — it remains allowed
  (admin superset); agent grants are additive, not a downgrade of admin.
- MCP document-management tools vs agent retrieval tools — see Assumptions; management tools
  require the admin role, agent tools require the agent grant's role, same protocol.
- A grant with allow-all origins paired with a non-browser surface (REST/MCP) — origin constraint
  is simply inert there; role-based permission and credential validity still govern.
- Migrating the single per-workspace API token: it stays the admin token; no agent grant is
  auto-created for it.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be Node.js/TypeScript; frontend MUST be React; database MUST be PostgreSQL.
- Backend development MUST follow TDD: failing tests before implementation.
- Frontend user-visible behavior MUST prefer Playwright; unit tests stay on non-visual logic.
- Secrets/keys MUST live in `.env`; `.env.example` updated if config changes. Grant secrets MUST
  be stored hashed, never plaintext, and revealed once at issuance.
- Customer data MUST follow least-privilege; roles MUST default to the narrowest viable set.
- Features MUST preserve modular boundaries between transport, orchestration, domain, persistence.
- Public API, SDK, and MCP contract changes MUST update the OpenAPI registry, generated artifacts,
  contract tests, and docs.
- Contract changes MUST include a message-queue impact review (worker dispatch, AMQP payloads,
  retry semantics, queue docs/tests).
- No hard-coded English product vocabulary for behavior; scope/constraint config is structured data.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP middleware owns authentication extraction and principal attachment
  (as established in 062); a new domain owns the **access-grant credential lifecycle and
  credential-validity** (issue/rotate/revoke/touch, origin match, revoked/disabled/expired) — NOT
  permission decisions; the existing `AccountAccessService` remains the sole authorizer via role →
  permission; repositories own persistence and secret-hash lookup; public-chat services keep owning
  launch/session behavior; composition (`backend/src/app/composition/`) wires the grant repository
  and origin matcher as replaceable infrastructure.
- **Encapsulation Rule**: Reuse 062's `AuthenticatedPrincipal` and `requirePermission` seam —
  do **not** fork a parallel auth path. The grant entity MUST NOT carry a `scopes[]` array and the
  grant/credential service MUST NOT decide permission membership; permission decisions live ONLY in
  `AccountAccessService` as role → permission. The grant domain must not embed HTTP concerns;
  route handlers must not embed role matrices. The existing `workspace_tokens` admin path stays
  intact as the admin tier.
- **New Seams Required**:
  - `AccessGrant` entity + `AccessGrantRepository` port (supersedes the two divergent credential
    paths: plaintext public-surface tokens and `workspace_tokens`-style lifecycle), bound to an
    agent, carrying credential lifecycle + **role** + origin constraint + enabled + audit. No
    permission/scope set.
  - `OriginMatcher` port: `AllowAll | Origins[]` → boolean, one implementation reused by every
    browser-reachable surface, preserving the embed same-origin binding subtlety.
  - A new **`public` role** in `AccountAccessService` (the existing `public_chat` role / 
    `PUBLIC_CHAT_PERMISSIONS` is its permission set) and an `agent_access_grant` principal that
    carries a role, resolved through the existing role → permission mapping. Later `member` /
    agent-api roles are added centrally in the same module.
- **Anti-Goals**: Do not give the grant a `scopes[]` array or any permission-membership logic. Do
  not add a second permission-decision site outside `AccountAccessService`. Do not duplicate
  `PUBLIC_CHAT_PERMISSIONS` onto the grant. Do not collapse the public-launch auth lane into the
  bearer lane. Do not auto-grant admin to agent grants. Do not add IP/CIDR allow-lists in this
  phase. Do not move the per-workspace admin token to per-agent. Do not absorb grant lifecycle into
  `AuthService` or a route handler.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST model an **Access Grant** as a first-class entity bound to a single
  agent, carrying: credential (hashed, prefixed, rotatable, revocable, last-used), a **role**,
  origin constraint, enabled flag, optional label, and audit metadata. The grant MUST NOT carry a
  permission/scope array.
- **FR-002**: System MUST issue, rotate, revoke, and record last-used for every agent grant
  through one shared lifecycle, regardless of surface (embed, public link, agent REST, agent MCP).
- **FR-003**: System MUST migrate existing website-embed and public-chat tokens into equivalent
  agent access grants without loss of access.
- **FR-004**: System MUST keep the existing per-workspace admin workspace API token as the sole
  workspace-level credential (admin tier), unchanged in binding level.
- **FR-005**: System MUST authorize each grant by its **role**, resolved through
  `AccountAccessService`'s existing role → permission mapping; permission decisions MUST NOT be made
  by the grant entity, a grant `evaluate()`, or a route handler.
- **FR-006**: System MUST add a **`public` role** whose permission set is the existing
  `PUBLIC_CHAT_PERMISSIONS` (single source of truth, not copied), and an `agent_access_grant`
  principal carrying a role; admin tokens MUST remain a superset. Later roles (`member`, agent-api)
  are added as role → permission mappings in the same module, not as per-grant arrays.
- **FR-007**: System MUST evaluate an origin constraint per grant supporting an explicit allow-all,
  an explicit origin list, and an empty list meaning allow-none.
- **FR-008**: System MUST apply origin matching for the website-embed widget using the bound
  session origin (not the live `Origin` header), preserving #609→#612 behavior.
- **FR-009**: System MUST reject public-launch grants presented through the `Authorization: Bearer`
  path on REST/MCP endpoints (062 invariant preserved under the unified model).
- **FR-010**: System MUST deny any grant request targeting an agent or workspace other than the one
  it is bound to, without enumeration.
- **FR-011**: Users MUST be able to issue multiple labeled grants per agent surface and enable,
  disable, or revoke each independently. *(P2)*
- **FR-012**: System MUST reveal a grant secret exactly once at issuance and persist only its hash.
- **FR-013**: System MUST emit audit events for grant issue/rotate/revoke/role-change/enable, and
  an authorization-failure signal distinguishing revoked / permission-denied / origin-denied —
  without logging secret material, raw origins-as-credentials, prompts, or document content.
- **FR-014**: System MUST update API, SDK, MCP, and operator docs to describe grants, the `public`
  role, and the allow-list, and include a message-queue impact review.
- **FR-015**: System MUST provide backend regression coverage for: role-permission allowed vs
  denied (via `AccountAccessService`), rotate/revoke, origin allow/deny/allow-all/allow-none,
  public-launch bearer rejection, and wrong-agent/wrong-workspace denial.

### Out of Scope (this phase)

- IP/CIDR allow-lists (origin-only for now; matcher port must not foreclose it later).
- Per-workspace default grant layer (decision: none; admin token is the only workspace-level credential).
- Member/human-user API tokens beyond the agent-grant principal.
- Grant expiry UI (model the field if cheap; surfacing deferred — see open question).

### Key Entities

- **Access Grant**: Agent-bound credential with a **role**, origin constraint, lifecycle state,
  optional label, and audit. Carries no permission/scope array. The unification target for embed,
  public-link, agent-REST, agent-MCP.
- **Workspace Admin Token**: The per-workspace admin credential from 062; unchanged tier; admin
  role superset; not represented as an agent grant.
- **Grant Principal Kind**: Distinguishes the auth lane — `workspace-admin` (bearer, management),
  `agent-api` (bearer, agent-scoped), `public-launch` (session-exchange only, never bearer).
- **Role**: The unit of authorization, defined ONCE in `AccountAccessService` as a role → permission
  mapping. `public` (= `PUBLIC_CHAT_PERMISSIONS`) ships in this phase; `admin`/`member` already
  exist; agent-api roles come later. A grant references a role; it does not enumerate permissions.
- **Origin Constraint**: `AllowAll | Origins[]` (empty = allow-none) evaluated per grant (a
  credential constraint, not a permission).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: One access-grant lifecycle backs all four surfaces; no surface retains a bespoke
  token store after migration (verified by code/contract review and tests).
- **SC-002**: Existing embed/public-chat tokens and the workspace admin token continue working
  across the upgrade with zero manual re-issuance.
- **SC-003**: In validation, 100% of public-launch credentials presented as bearer to REST/MCP are
  denied (062 invariant holds under the unified model).
- **SC-004**: In validation, a `public`-role grant is allowed on the public-chat permission set and
  denied on all others — the decision made by `AccountAccessService` (role → permission), with no
  `scopes[]` on the grant and no permission logic in the grant/credential service.
- **SC-005**: Origin allow-list behaves identically across every browser-reachable surface,
  including allow-all and allow-none, with embed same-origin binding preserved.
- **SC-006**: Operators can issue, label, disable, and independently revoke multiple grants per
  agent. *(P2)*
- **SC-007**: API/SDK/MCP/operator docs describe grants, the `public` role, and allow-list, and no
  longer imply channel-specific credential behavior.

## Assumptions

- This is the named Phase 2 of `062-multiple-role-tokens`; its principal model and
  `requirePermission` seam are the foundation, extended — not replaced.
- The 062 term "public launch credential" remains canonical; avoid "guest token".
- Runtime conversational assistant behavior and backend prompt assets are unchanged.
- Message-queue behavior is expected unaffected, but the plan MUST verify and record it.
- **Access is role-based, not per-grant scopes.** Authorization stays in `AccountAccessService` as
  role → permission, reusing the existing `Permission` vocabulary. This phase adds a `public` role
  (= `PUBLIC_CHAT_PERMISSIONS`); `admin`/`member` already exist (`WorkspaceApiTokenRole`). A grant
  references a role; it does not carry a permission array, and there is no permission-decision site
  outside the access module.

## Resolved Decisions

- **RD-1 (MCP role split)** — *Resolved:* MCP is one protocol gated by role. Document-management
  MCP tools require the admin role and remain driven by the admin token; agent-scoped MCP tools
  (grounded answer/search against one agent) are driven by an agent grant's role. No second MCP
  surface; the principal's role (resolved in `AccountAccessService`) decides which tools answer.
- **RD-2 (Expiry)** — *Resolved:* Model a nullable `expiresAt` on the grant now (null = no expiry)
  and enforce it at validation; the management UI for setting expiry is deferred. Cheap to include,
  expensive to retrofit.
- **RD-3 (Agent REST transition)** — *Resolved:* Non-breaking. The per-workspace admin token
  continues to satisfy agent-API calls (admin is a superset); agent grants are an *additional,
  narrower* path, never a forced replacement. Any future deprecation of admin-token-for-agent-calls
  is a later phase, not this one.
```

This spec is a draft for sign-off; implementation must not begin until approved (constitution rule).
