# Feature Specification: Public Chat Browser Access

**Feature Branch**: `077-public-chat-browser-access`  
**Created**: 2026-06-04  
**Status**: Approved  
**Tracking**: GitHub issue #600  
**Input**: User description: "Make Radioso public chat callable directly from approved browser origins for the Radioso website agent, using public tokens and the website embed allowlist rather than admin API tokens. Public chat access must be a **limited public role** expressed in the existing permission model — not a new principal/capability framework, and not a workspace API-token role — and must not reinvent chat execution or broaden workspace permissions."

## Scope Decision

This feature has two deliverables, both in scope:

1. **Browser transport fix (closes #600).** The public-chat browser route must return CORS preflight/response headers for approved website-embed origins, and must reject `stream: false` with a documented JSON error instead of a silent `204`. The working `frontend/app/api/embed/session/[token]/route.ts` already implements the correct `OPTIONS`/origin-echo pattern; the public-chat proxy does not. This is the asymmetry to remove.

2. **Limited public role.** Public chat sessions get a narrow role with exactly four permissions and nothing else. This is a small role added to the **existing** permission decision point (`AccountAccessService`), enforced by a thin public guard. It is explicitly **not** a parallel "capability" vocabulary, and **not** a `WorkspaceApiTokenRole` (`admin | member`) value — those resolve on the bearer-token path, which public launch credentials must never enter.

The four permissions are: `public_chat.turn.create`, `public_chat.session.read.own`, `public_chat.history.read.own`, `public_chat.feedback.write.own`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stream Website Agent Answers From Approved Origins (Priority: P1)

As a visitor on an approved website such as `radioso.dev`, I need the site's agent interface to stream grounded Radioso answers directly in the page, so that the website can demonstrate Radioso without opening the embedded chat widget.

**Why this priority**: This is the production-visible blocker. The website should use Radioso's public surface safely and should not need admin API credentials or a separate private backend to ask the public agent.

**Independent Test**: Can be fully tested by configuring a website embed token with an approved origin, exchanging it for a public session, and sending a streaming message from that origin. The answer should stream with citations and without browser CORS errors.

**Acceptance Scenarios**:

1. **Given** website embed is enabled for an agent and `https://radioso.dev` is in the allowed origins, **When** a browser request from `https://radioso.dev` exchanges the public launch token for a session and sends a streaming chat message, **Then** Radioso streams answer events that the website can render.
2. **Given** the same approved public session, **When** the browser sends a chat preflight request with the public session header, **Then** the preflight succeeds with only the approved origin reflected.
3. **Given** the website sends a normal message request with streaming enabled, **When** the assistant completes the answer, **Then** the stream includes enough final metadata for citations, conversation identity, and feedback/history continuity.

---

### User Story 2 - Public Access Cannot Become Workspace API Access (Priority: P1)

As a security reviewer, I need public launch credentials and public chat sessions to be unable to read or change workspace settings, documents, agents, credentials, or tokens, so that browser-exposed credentials remain least-privilege even if copied.

**Why this priority**: Public tokens are intentionally exposed to browsers. The safety boundary must be a narrow public role plus session binding, not secrecy.

**Independent Test**: Can be fully tested by using website embed launch credentials and issued public session tokens against normal workspace, settings, document, agent, retrieval, history, token, and MCP endpoints. Each attempt should fail unless it is a public chat route explicitly covered by the public role.

**Acceptance Scenarios**:

1. **Given** a valid website embed launch credential, **When** it is supplied as `Authorization: Bearer` to normal workspace API endpoints, **Then** the request is rejected.
2. **Given** a valid public chat session, **When** it is used on settings, documents, agents, token, credentials, authenticated history, retrieval, or MCP endpoints, **Then** the request is rejected.
3. **Given** a public chat session, **When** authorization is evaluated, **Then** the public role grants only the four `public_chat.*` permissions for the session's own surface and denies every `workspace.*`/`account.*` permission.
4. **Given** a signed-in user or workspace API token, **When** authorization is evaluated, **Then** the four `public_chat.*` permissions are never granted to it (the public permissions are public-role-only).

---

### User Story 3 - Disallowed Origins Fail Closed (Priority: P1)

As an operator, I need the website embed allowlist to govern direct browser chat access, so that only approved websites can use a browser to launch or stream from a website embed token.

**Why this priority**: Direct browser access must preserve the same public-surface policy operators already configure for the embedded widget.

**Independent Test**: Can be fully tested by configuring one approved origin and making session exchange, preflight, and streaming requests from both approved and unapproved origins.

**Acceptance Scenarios**:

1. **Given** an origin is not in the website embed allowed origins, **When** it attempts session exchange, **Then** the request is denied and no usable public session is issued.
2. **Given** an origin is not in the website embed allowed origins, **When** it sends a public chat preflight request, **Then** the response does not authorize that origin.
3. **Given** a public session issued for one approved origin, **When** a different origin uses the same session token, **Then** the message request is denied.
4. **Given** an origin was approved when a session was issued but is later removed from the allowlist, **When** that origin tries to send another message, **Then** the request is denied.

---

### User Story 4 - Shared Chat Execution Without Shared Trust (Priority: P2)

As a maintainer, I need authenticated chat and public chat to share the same answer/stream execution behavior after authorization, so that public website access does not create a divergent chat stack.

**Why this priority**: The missing behavior is access and browser transport, not a new assistant runtime. Shared execution reduces behavioral drift while preserving different trust boundaries.

**Independent Test**: Can be tested by comparing authenticated and public chat turns for streaming lifecycle, citation rendering data, conversation identifiers, and error handling while verifying each path uses its own authorization rule.

**Acceptance Scenarios**:

1. **Given** an authenticated workspace user and a public website session ask comparable questions, **When** both requests are authorized, **Then** both use the same assistant turn behavior appropriate to their configured agent.
2. **Given** public chat access is authorized, **When** the answer stream is emitted, **Then** public-only presentation rules such as citation artifact stripping and debug suppression still apply.
3. **Given** authenticated access is authorized, **When** the caller has permission to request debug information, **Then** public access rules do not restrict the authenticated path.

### Edge Cases

- What happens when a website sends a message with `startConversation` and streaming enabled? The request must fail with a clear documented error rather than silently returning an empty response.
- What happens when a browser sends `stream: false`? If non-streaming public browser messages are not supported, the request must fail with a clear documented error; if supported, it must return a documented response shape.
- What happens when a request omits `Origin`? Website embed browser access must fail closed for website-embed sessions. Anonymous link behavior may remain separate when it does not rely on browser origin authorization.
- What happens when an origin differs only by scheme, port, or trailing slash? Origin comparison must use normalized origin semantics.
- What happens when a public session token expires, is malformed, or is bound to a rotated launch token? The request must fail without leaking workspace or agent existence.
- What happens when public chat rate limits are exceeded? The response must remain browser-consumable and must not disclose privileged workspace information.

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
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Public API, SDK, and MCP contract changes MUST update the code-first OpenAPI registry and generated artifacts.
- Contract changes MUST include a message-queue impact review that states whether document worker dispatch, AMQP payloads, retry semantics, or queue docs/tests need updates.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes own transport details, request validation, CORS response shaping, and route-local error translation. Public chat session middleware owns public session extraction, launch-token binding, origin/session validation, and attaching the public role to the request. `AccountAccessService` remains the single permission decision point for every principal type (signed-in user, workspace API token, and now the public role). A thin public guard delegates to that same decision point rather than embedding its own matrix. Chat services own assistant turn behavior. Repositories own token, agent, workspace, and settings lookup.
- **Encapsulation Rule**: Public launch credentials must not enter the workspace bearer-token path. `requireWorkspaceSession` and `requireWorkspacePermission` must remain workspace-auth helpers and must not learn website embed allowlist logic. Public chat route handlers must not embed role matrices or duplicate assistant turn orchestration. Website embed session and direct public chat CORS decisions must use one shared allowlist resolver rather than separate ad hoc header logic.
- **New Seams Required**:
  - A `public_chat_session` variant of `AuthenticatedPrincipal` carrying the limited public role, derived from a validated public chat session by the public-session middleware. This is a request-local access context, not a new authorization framework.
  - The four `public_chat.*` permission strings added to the existing permission vocabulary, granted to the public role and only the public role.
  - A single decision-point branch in `AccountAccessService.hasPermission` so a `public_chat_session` principal is allowed exactly its four permissions and denied all `workspace.*`/`account.*`; conversely those four are never granted to workspace roles.
  - A thin `requirePublicChatPermission` guard that reads the public principal from request locals and delegates to `AccountAccessService` — no `accountId`/membership coupling on the public path.
  - The CORS/transport fix on the public-chat browser proxy, reusing the website-embed allowlist resolver already used by the session route.
- **Anti-Goals**: Do not introduce a parallel "capability" type system alongside the existing permission model — the public role lives in the one permission model. Do not model public launch credentials as normal workspace API bearer secrets. Do not reuse or extend the `member`/`admin` `WorkspaceApiTokenRole` for public chat access. Do not grant the public role any workspace settings, document, agent, credential, token, MCP, debug, or admin permission. Do not make CORS reflection the source of authorization. Do not implement a separate assistant runtime for the website, and do not refactor the existing shared chat execution beyond what authorization attachment requires.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST allow an approved website embed origin to exchange a public website embed launch credential for a short-lived public chat session.
- **FR-002**: System MUST allow an approved website embed origin to send streaming public chat messages using the issued public session.
- **FR-003**: System MUST return browser-compatible CORS responses for public chat session exchange, preflight, and streaming message requests only when the origin is approved for the website embed token.
- **FR-004**: System MUST validate message POST requests against the public session's bound source origin and the current website embed allowlist.
- **FR-005**: System MUST reject message requests when the public session source origin does not match the request origin.
- **FR-006**: System MUST reject message requests when website embed has been disabled or the origin has been removed from the allowlist after session issuance.
- **FR-007**: System MUST model a validated public chat session as a `public_chat_session` principal (an `AuthenticatedPrincipal` variant) distinct from signed-in users and workspace API tokens, attached on the public-session path.
- **FR-008**: System MUST define a limited public role granting exactly four permissions — `public_chat.turn.create`, `public_chat.session.read.own`, `public_chat.history.read.own`, `public_chat.feedback.write.own` — resolved through the existing `AccountAccessService` decision point, with a thin public guard enforcing them on public chat routes.
- **FR-009**: System MUST deny the public role all normal workspace and account permissions, including settings, documents, agents, credentials, tokens, authenticated history, retrieval API, MCP, debug, and account operations; and MUST never grant the four `public_chat.*` permissions to signed-in users or workspace API tokens.
- **FR-010**: System MUST continue rejecting public chat and website embed launch credentials supplied through `Authorization: Bearer` on normal workspace API and MCP endpoints.
- **FR-011**: System MUST preserve anonymous public chat behavior where it is intentionally separate from website embed origin-allowlisted browser access.
- **FR-012**: System MUST provide clear documented error responses for unsupported public chat request combinations such as streaming bootstrap or unsupported non-streaming message requests.
- **FR-013**: System MUST preserve the existing shared assistant turn execution after authorization (public and authenticated paths already converge on the same chat service); this feature MUST NOT fork or refactor that execution beyond attaching the resolved access context.
- **FR-014**: System MUST suppress debug output for public chat principals even if the request asks for debug details.
- **FR-015**: System MUST preserve public citation display settings and public citation artifact stripping for public chat responses.
- **FR-016**: System MUST expose enough final stream metadata for the website to support citations, conversation continuity, and feedback on the visitor's own answer.
- **FR-017**: System MUST record or preserve audit/rate-limit signals needed to distinguish allowed public website launches, denied origin attempts, and public chat message abuse.
- **FR-018**: System MUST update public API/OpenAPI contracts, generated SDK artifacts, and relevant docs when route behavior, payloads, status codes, headers, or stream events change.
- **FR-019**: System MUST include backend regression tests before implementation for allowed origin streaming, denied origin preflight, denied origin message POST, origin mismatch with a valid session, public principal permission denial, and public launch credential bearer rejection.
- **FR-020**: System MUST include frontend adapter tests or end-to-end coverage proving the website can consume public chat streaming without relying on admin API credentials.

### Key Entities *(include if feature involves data)*

- **Public Launch Credential**: A public website embed token that can initiate session exchange for approved origins but cannot authenticate normal workspace APIs.
- **Public Chat Session**: A short-lived signed session bound to a workspace, agent, public session id, source channel, source origin, and launch token.
- **Public Chat Principal**: The `public_chat_session` request identity derived from a valid public chat session; it carries the limited public role and no workspace role.
- **Public Role**: A fixed, minimal permission bundle in the existing permission model granting exactly `public_chat.turn.create`, `public_chat.session.read.own`, `public_chat.history.read.own`, and `public_chat.feedback.write.own`.
- **Allowed Origin**: A normalized website origin configured by the operator for the website embed surface.
- **Chat Access Context**: The normalized authorization result consumed by shared chat execution after either authenticated or public access has been resolved.

### Assumptions

- The Radioso website will use the website embed token and allowed origin model rather than a secret workspace API token.
- The desired website experience is streaming answers, not non-streaming JSON.
- The existing embedded widget must continue working without behavioral regressions.
- Existing anonymous public chat links remain a separate public surface and should not be accidentally made origin-bound unless explicitly specified in a future spec.
- No new secrets or environment variables are required for this feature.
- Message queue behavior is expected to be unaffected because chat authorization and browser transport do not change document worker dispatch or queue payloads.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A browser on an approved origin can complete public session exchange and receive a streamed answer without CORS errors in 100% of covered regression tests.
- **SC-002**: Requests from unapproved origins fail for session exchange, preflight, and message POST in 100% of covered regression tests.
- **SC-003**: A valid public session token reused from a different origin is denied in 100% of covered regression tests.
- **SC-004**: Public launch credentials and public session tokens fail on normal workspace API and MCP bearer paths in 100% of covered regression tests.
- **SC-005**: Public chat principals receive zero workspace settings, document, agent, credential, token, MCP, or debug permissions in authorization tests.
- **SC-006**: Public and authenticated chat paths share streaming lifecycle behavior while retaining distinct authorization and presentation restrictions in covered tests.
- **SC-007**: The Radioso website can enable live streaming mode using only public credentials and approved-origin configuration, with no admin API token in browser code or build output.
- **SC-008**: API/SDK/docs updates describe public browser streaming access clearly enough that operators can enable it without support intervention.
