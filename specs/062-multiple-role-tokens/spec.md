# Feature Specification: Token Authorization Phase 1

**Feature Branch**: `062-multiple-role-tokens`
**Created**: 2026-05-17
**Status**: Approved for Phase 1 implementation
**Input**: User description: "Implement Phase 1 of the S1 remediation: remove the blanket bearer-token permission bypass, model workspace API tokens as explicit principals, preserve existing tokens as admin workspace API tokens, add route permission declarations and regression tests, and record multiple-token/productized access management as a follow-up issue."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Workspace API Tokens Follow Explicit Permissions (Priority: P1)

As an operator responsible for customer data protection, I need workspace API tokens to authorize through explicit permissions instead of a blanket bearer-token bypass, so that automation cannot perform workspace actions unless the token principal is allowed to do so.

**Why this priority**: This directly remediates the S1 finding and removes the bug class rather than patching one line.

**Independent Test**: Can be fully tested by using an existing workspace API token against workspace read routes, member-allowed mutations, admin-only mutations, token-management routes, and owner/session-only routes while verifying each result follows the declared permission.

**Acceptance Scenarios**:

1. **Given** a workspace API token exists from before this change, **When** it authenticates after upgrade, **Then** it is treated as an explicit admin workspace API token for its bound workspace.
2. **Given** a workspace API token calls a route whose declared permission is allowed for its token role, **When** the request is valid for the token's bound workspace, **Then** the request succeeds.
3. **Given** a workspace API token calls a route whose declared permission is not allowed for API-token principals, **When** the request is made, **Then** the request is denied without falling through a bearer bypass.
4. **Given** a workspace API token calls a route for another workspace, **When** the target workspace differs from the token-bound workspace, **Then** access is denied without leaking whether the other workspace exists.

---

### User Story 2 - Public Launch Credentials Stay Out of Bearer Auth (Priority: P1)

As a security reviewer, I need public chat and embedded chat launch credentials to be impossible to use as normal bearer API tokens, so that intentionally exposed public credentials cannot become workspace API secrets.

**Why this priority**: This preserves the clean boundary between public chat launch/session exchange and secret workspace automation credentials.

**Independent Test**: Can be fully tested by using public chat and website embed launch credentials on public session-exchange endpoints and then trying the same values through `Authorization: Bearer` on normal workspace, document, settings, history, retrieval, and MCP endpoints.

**Acceptance Scenarios**:

1. **Given** a public chat launch credential exists, **When** it is used on the public chat session-exchange route, **Then** the existing public session flow continues to govern access.
2. **Given** a website embed launch credential exists, **When** it is used on the embed session-exchange route, **Then** existing origin validation and public session protections continue to govern access.
3. **Given** any public launch credential is supplied as `Authorization: Bearer`, **When** it targets normal workspace API or MCP endpoints, **Then** authentication fails.

---

### User Story 3 - Mixed Auth Cannot Broaden Privilege (Priority: P1)

As an operator, I need requests that include both a signed-in session cookie and a bearer token to resolve predictably, so that stale cookies or mixed clients cannot accidentally broaden token access.

**Why this priority**: Mixed auth precedence is a common authorization bug source and must be a hard requirement, not an implementation note.

**Independent Test**: Can be fully tested by sending requests with a valid session plus a valid bearer token, a stale session plus a valid bearer token, and a valid session plus an invalid bearer token.

**Acceptance Scenarios**:

1. **Given** a valid signed-in session is present, **When** the request also includes a bearer token, **Then** the documented precedence rule is applied consistently and cannot grant broader access than the selected principal.
2. **Given** a stale or invalid session cookie is present with a valid bearer token, **When** the request is made, **Then** fallback behavior is explicit, tested, and does not inherit privileges from the stale session.
3. **Given** a valid session cookie is present with an invalid bearer token, **When** the request is made, **Then** the request outcome follows the documented precedence rule and is covered by regression tests.

---

### User Story 4 - Authorization Decisions Are Regression-Tested (Priority: P2)

As a maintainer, I need regression tests proving no bearer token can skip declared permissions, so that future route or middleware changes do not reintroduce S1.

**Why this priority**: The remediation is only durable if route coverage and permission declarations are tested.

**Independent Test**: Can be fully tested by running backend contract and unit tests that exercise representative bearer-authenticated routes across allowed, denied, wrong-workspace, stale-session, and public-launch-credential cases.

**Acceptance Scenarios**:

1. **Given** a route accepts workspace bearer authentication, **When** tests inspect or exercise the route, **Then** it has a declared permission or an explicit read/public exception.
2. **Given** bearer auth is used on protected workspace routes, **When** the required permission is not allowed for the principal, **Then** tests verify denial.
3. **Given** the permission middleware is executed for bearer auth, **When** the principal is a workspace API token, **Then** tests verify the decision flows through explicit authorization rather than a bypass.

### Edge Cases

- What happens to the existing single workspace token? It continues as an explicit admin workspace API token for compatibility.
- What happens when a token secret is malformed, unknown, or public-chat-like? It is rejected by the workspace API bearer-auth path.
- What happens when a token targets a workspace other than its bound workspace? Access is denied without workspace enumeration.
- What happens when a route currently relies only on workspace-session middleware? Phase 1 must add an explicit permission declaration or document and test an intentional read-only exception.
- What happens when MCP validates a workspace API token? It must accept only workspace API token principals, not public launch credentials.
- What happens when a signed-in user and bearer token are both present? The implemented precedence rule must be documented and covered by tests.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated if configuration changes.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Public API, SDK, and MCP contract changes MUST update the code-first OpenAPI registry, generated artifacts, contract tests, and relevant docs.
- Contract changes MUST include a message-queue impact review that states whether document worker dispatch, AMQP payloads, retry semantics, or queue docs/tests are affected.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP middleware owns authentication extraction and request-local principal attachment; account access policy owns role-to-permission decisions; public chat services own launch credential and public session behavior; repositories own persistence and secret lookup details.
- **Encapsulation Rule**: `requireWorkspaceSession` and `requirePermission` must not contain hard-coded broad bearer-token bypasses. Route handlers must remain transport-only and must not embed role matrices. `AuthService` may authenticate tokens but must not become the long-term owner of productized token-management workflows.
- **New Seams Required**: An explicit authenticated principal model that distinguishes signed-in sessions, workspace API tokens, and public chat sessions; route-level permission declarations for workspace endpoints that accept bearer authentication; a hard invariant that public launch credentials are never accepted by the workspace API bearer-auth path.
- **Anti-Goals**: Do not add another exception that lets bearer tokens skip permission checks. Do not model public launch credentials as normal workspace API bearer secrets. Do not add multi-token lifecycle, token-management UI, custom scopes, or guest credential display in Phase 1.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST model authenticated callers as explicit principals, including signed-in session users, workspace API tokens, and public chat sessions.
- **FR-002**: System MUST treat existing workspace API tokens as explicit admin workspace API token principals for compatibility.
- **FR-003**: System MUST remove the behavior where bearer-token authentication automatically bypasses workspace permission checks.
- **FR-004**: System MUST route workspace API token authorization through declared route permissions or explicit tested read-only exceptions.
- **FR-005**: System MUST deny workspace API token requests for owner-only or interactive-session-only account operations.
- **FR-006**: System MUST deny workspace API token requests that target a workspace other than the token-bound workspace.
- **FR-007**: System MUST reject public chat and website embed launch credentials supplied through the `Authorization: Bearer` path.
- **FR-008**: Public launch credentials MUST remain valid only on public chat or embedded chat session-exchange endpoints governed by existing public-chat protections.
- **FR-009**: System MUST define, implement, document, and test mixed session-cookie plus bearer-token precedence.
- **FR-010**: System MUST ensure MCP context and merged MCP token verification accept workspace API token principals only, not public launch credentials.
- **FR-011**: System MUST include backend regression coverage proving bearer tokens cannot skip declared permissions.
- **FR-012**: System MUST document Phase 1 token semantics in the affected API, SDK, MCP, and operator docs where current docs imply broad workspace token behavior.
- **FR-013**: System MUST include a message-queue impact review and document whether token authorization changes affect document worker dispatch, AMQP payloads, retry semantics, or queue tests/docs.

### Out of Scope for Phase 1

- Multiple simultaneous API tokens per workspace.
- Token labels, token-management UI, token list screens, and one-time secret display changes beyond existing behavior.
- Member API token creation or productized role selection.
- Guest credential display in token/access management.
- Fine-grained custom scopes such as crawler-only, ingest-only, retrieval-only, chat-only, or MCP-read-only.
- Audit UI and expanded lifecycle analytics beyond existing audit behavior needed for authorization failures.

### Key Entities

- **Authenticated Principal**: The request identity selected after authentication, such as session user, workspace API token, or public chat session.
- **Workspace API Token Principal**: A secret automation credential bound to one workspace and treated as admin in Phase 1 for compatibility with existing tokens.
- **Public Launch Credential**: A public chat or website embed launch value that can initiate public session exchange but cannot act as a bearer API token.
- **Route Permission Declaration**: The permission or explicit exception required for a workspace route that accepts bearer authentication.
- **Token Access Decision**: The authorization outcome for a request, including allowed, insufficient permission, invalid token, public credential rejected, or wrong workspace.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Existing workspace API tokens continue intended automation after upgrade as explicit admin token principals.
- **SC-002**: In validation, no route that accepts bearer authentication relies on a blanket workspace permission bypass.
- **SC-003**: In validation, 100% of public launch credential attempts to authenticate normal workspace API or MCP endpoints are denied.
- **SC-004**: In validation, wrong-workspace workspace API token requests are denied without workspace enumeration.
- **SC-005**: In validation, mixed session-cookie plus bearer-token requests follow one documented precedence rule across covered routes.
- **SC-006**: Backend regression tests cover allowed bearer access, denied bearer access, wrong-workspace bearer access, public launch credential rejection, and mixed-auth behavior.
- **SC-007**: API, SDK, MCP, and operator documentation no longer imply that workspace bearer tokens bypass workspace permission checks.

## Assumptions

- The current broad workspace token should remain compatible by becoming an explicit admin workspace API token principal.
- Phase 1 does not introduce member token creation, but the principal and permission model should leave room for member tokens in Phase 2.
- Owner-only account operations remain session-user only and are not granted to API tokens.
- Public launch credential is the canonical term; "guest token" should be avoided in product and developer-facing copy.
- This feature should not change runtime conversational assistant behavior or introduce new backend prompt assets.
- Message queue behavior is expected to be unaffected, but the plan must explicitly verify and record that conclusion.
