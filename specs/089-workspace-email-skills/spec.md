# Feature Specification: Workspace Email Connections and Skills

**Feature Branch**: `email-skill-exposure` (global feature number 089)  
**Created**: 2026-06-15  
**Status**: Draft  
**Input**: User description: "Set up customer-owned email per workspace, start with OAuth, abstract OAuth for use by other modules, then expose customer email as agent skills. Radioso-owned transactional email remains separate."

> **Branch note**: This Conductor workspace is already on `email-skill-exposure`; do not rename the branch. This spec lives under `specs/089-workspace-email-skills/` to preserve global numbering.

## Problem

Radioso has two distinct email concerns that should not share a public execution surface:

1. **Radioso-owned transactional email**: password reset, email verification, invitations, and other product/system messages sent by Radioso.
2. **Customer-owned outbound email**: messages sent through a workspace customer's own mail provider, intentionally exposed to agents as constrained skills.

The existing `backend/src/modules/mail/` service is appropriate for Radioso-owned transactional delivery, but customer-owned email needs a different model: workspace operators authorize their own provider, agent authors define named skills over that connection, and routines invoke those skills through the existing skill/action spine. OAuth should be the first-class setup path, and the OAuth machinery should be reusable by other integration modules. If the MCP OAuth work lands first, this feature must reuse or extract that substrate rather than building a parallel OAuth flow.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Authorize a reusable workspace OAuth connection (Priority: P1)

A workspace operator connects an OAuth-capable mail provider from workspace settings. They start authorization, complete provider consent, return to Radioso, and see the connection marked authorized. The same OAuth foundation is reusable by other modules, including MCP/external skills, so email does not own OAuth-specific state-machine logic.

**Why this priority**: Customer email skills cannot run without a safe way to hold customer-authorized credentials. Making OAuth reusable first prevents email from creating a one-off credential path that MCP and future integrations would have to duplicate.

**Independent Test**: Against a mock OAuth provider, create a workspace connection, complete authorization, verify encrypted token storage, refresh an expired token before use, and confirm a refresh failure marks the connection as needing re-authorization. The test must exercise the OAuth substrate without depending on email message delivery.

**Acceptance Scenarios**:

1. **Given** a workspace with no customer email connection, **When** an operator starts OAuth setup for a supported mail provider, **Then** Radioso creates a pending connection and returns a provider authorization URL with state protection.
2. **Given** the operator grants provider consent, **When** the OAuth callback is completed, **Then** Radioso stores the resulting credential set encrypted and marks the connection authorized without exposing tokens to the UI.
3. **Given** an authorized connection with an expired access token and a valid refresh token, **When** a consumer module requests a usable credential, **Then** the OAuth substrate refreshes the token, persists the new encrypted credential state, and returns a usable authorization view.
4. **Given** refresh fails or provider consent is revoked, **When** a consumer module requests a usable credential, **Then** the connection is marked `needs_reauth` and the caller receives a stable failure reason.
5. **Given** the MCP OAuth implementation already provides equivalent authorization, callback, refresh, status, and encrypted token storage behavior, **When** this feature is planned, **Then** the email feature reuses or extracts that reusable OAuth substrate instead of creating a second OAuth module.

---

### User Story 2 - Configure a customer-owned email connection (Priority: P1)

A workspace operator configures a customer-owned outbound email connection backed by an authorized OAuth connection. They can view its status, re-authorize it, disable it, and remove it when no skills depend on it. This connection is separate from Radioso transactional mail and is never used for password reset, verification, or product/system messages.

**Why this priority**: Operators need a clear and auditable boundary between Radioso's own email and customer-authorized email. A workspace connection is the reusable resource that agent skills can safely reference.

**Independent Test**: Authorize a mock mail provider, create a workspace email connection using that provider, confirm the non-secret connection summary is visible, disable and re-enable it, and verify deletion is blocked while a skill references it.

**Acceptance Scenarios**:

1. **Given** an authorized OAuth mail provider connection, **When** the operator creates a customer email connection, **Then** the connection is listed in workspace settings with provider, sender identity, status, and last health result, but no secrets.
2. **Given** a customer email connection, **When** the operator disables it, **Then** skills referencing it cannot send and return a disabled-connection outcome.
3. **Given** a connection referenced by one or more skills, **When** the operator attempts to delete it, **Then** deletion is blocked with a clear reference diagnostic.
4. **Given** a customer email connection exists, **When** Radioso sends password reset or verification email, **Then** that transactional email continues to use Radioso-owned mail configuration, not the customer connection.

---

### User Story 3 - Define an agent email skill (Priority: P2)

An agent author defines a named email skill over a workspace email connection. The author chooses whether the skill creates a draft or sends immediately, defines which fields are fixed versus filled by the conversation or routine slots, and sets constrained recipient/sender behavior. The resulting skill is an allowlisted product action, not raw provider API access.

**Why this priority**: The value is not merely storing a connection; it is letting customers intentionally expose their email provider to agents in a controlled way.

**Independent Test**: Create a skill named `support.email_customer` over a test connection, bind sender/reply-to/template fields, expose recipient and message fields, invoke it in draft mode, then switch to send mode and verify only the defined skill is callable.

**Acceptance Scenarios**:

1. **Given** a workspace email connection, **When** an agent author creates an email skill, **Then** they can choose a connection, name the skill, choose draft or send mode, and define bound and exposed inputs.
2. **Given** a skill exposes inputs to the conversation or routine, **When** the skill is saved, **Then** every required send/draft field is either bound by the author or declared as an exposed input.
3. **Given** a skill is in draft mode, **When** a routine invokes it, **Then** the system creates a provider draft or reviewable local draft outcome without sending the email.
4. **Given** a skill is in send mode, **When** a routine invokes it with valid inputs and an authorized connection, **Then** the system sends through the customer's configured provider and returns a typed success outcome.
5. **Given** an agent has no email skill definition, **When** the conversation asks the agent to email someone, **Then** the model cannot call the provider or send arbitrary mail.

---

### User Story 4 - Invoke email skills from routines with typed outcomes (Priority: P2)

A routine can invoke a defined email skill and branch on typed outcomes such as drafted, sent, disabled, needs reauthorization, provider rejected, or missing input. The routine engine stays provider-agnostic and sees only skill input/output data.

**Why this priority**: Email skills must fit the existing routine execution model rather than becoming a special case in chat or provider-specific code.

**Independent Test**: Define a routine that invokes an email skill after collecting slot data. Exercise success, missing input, disabled connection, and `needs_reauth` paths and verify the routine follows the expected branch without provider-specific code above the skill executor.

**Acceptance Scenarios**:

1. **Given** a routine step references an enabled email skill, **When** all exposed inputs are available, **Then** the step invokes the skill with bound plus supplied inputs.
2. **Given** required exposed inputs are missing, **When** the routine reaches the email step, **Then** the skill is not called with an invalid payload and the routine follows a missing-input path.
3. **Given** the provider rejects the message or the connection needs reauthorization, **When** the skill runs, **Then** the routine receives a stable failure outcome and can branch accordingly.
4. **Given** a routine invokes an email skill, **Then** the conversation engine, routine runner, and chat route remain unaware of provider-specific email APIs or OAuth token details.

---

### User Story 5 - Inspect customer email activity safely (Priority: P3)

Workspace operators can inspect email skill activity: which skill ran, which agent/routine invoked it, whether it drafted or sent, which provider outcome occurred, and when reauthorization is needed. Logs, audit events, and traces do not expose tokens, credentials, cookies, connection strings, or unnecessary message bodies.

**Why this priority**: Customer-owned email is an outbound side effect. Operators need enough visibility to debug and govern it without turning observability into a sensitive-content store.

**Independent Test**: Trigger drafted, sent, provider-failed, disabled, and needs-reauth outcomes; confirm the activity/audit surface distinguishes them and redacts secrets and message body content by default.

**Acceptance Scenarios**:

1. **Given** an email skill is invoked, **When** the operator views activity, **Then** they can see the skill, agent/routine, connection, non-secret recipient metadata, outcome, and timestamp.
2. **Given** provider delivery fails, **When** activity is recorded, **Then** the failure reason is stable and sanitized.
3. **Given** an email skill sends message content, **Then** default logs and traces do not store full body content unless a future explicit retention policy enables it.

### Edge Cases

- **OAuth state mismatch or expired callback**: authorization fails safely, no credential is stored, and the pending connection remains unauthorized.
- **Provider returns narrower scopes than requested**: the connection is not marked usable for send/draft skills until required scopes are present.
- **Refresh token revoked**: connection transitions to `needs_reauth`; routines receive a stable outcome rather than retrying indefinitely.
- **Connection disabled or deleted while a skill exists**: disabled connections return a typed runtime outcome; deletion is blocked while referenced.
- **Provider send quota exceeded**: skill returns provider-rejected/rate-limited outcome; Radioso does not attempt to bypass provider limits.
- **Recipient field malformed**: validation rejects the invocation before provider call.
- **Large message body or attachment request**: bounded validation applies; attachments are out of scope for the first feature.
- **Prompt injection asks to exfiltrate data by email**: only defined skills can be invoked, and they receive only the fields exposed by the skill/routine contract.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js; frontend workspace/agent settings screens MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` available; this feature adds relational credential/connection/skill records only.
- LLM integrations MUST use GPT-5.2 as the default provider if any model-assisted field filling or classification is introduced.
- User-facing assistant/chat copy around email skills MUST come from the LLM rather than hard-coded conversational strings so multilingual behavior remains intact.
- Backend development MUST follow TDD: failing tests first for OAuth lifecycle, encrypted credential storage, connection services, skill execution, and routing outcomes.
- Frontend user-visible behavior MUST prefer Playwright coverage for connection setup, authorization status, skill authoring, and routine invocation configuration.
- Secrets and tokens MUST be stored encrypted and never committed; `.env.example` MUST be updated for any new operator configuration.
- Customer data MUST be protected with least-privilege access and clear audit trails for customer-authorized outbound email.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and composition.
- The feature MUST NOT merge customer-owned email delivery into Radioso-owned transactional email delivery.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Radioso transactional mail*: `backend/src/modules/mail/` remains the owner for Radioso system email such as password reset and verification. It must not be exposed as a customer email skill surface.
  - *Reusable OAuth substrate*: OAuth authorization, state validation, encrypted token-set storage, refresh, reauthorization status, revocation status, and non-secret connection summaries belong in a provider-neutral OAuth module or extracted shared service. If MCP OAuth lands first, this feature must consume or extract that work rather than duplicate it.
  - *Customer email domain*: customer-owned email connection rules, sender identity, draft/send request validation, and email skill outcome mapping belong in a dedicated customer email module, separate from `modules/mail`.
  - *Provider adapters*: provider-specific Gmail/Microsoft/SMTP-over-OAuth details belong behind narrow adapter ports. Agent/routine code must not import provider SDKs.
  - *Skill execution*: email skills execute through the existing skill/action/routine spine. The conversation engine, routine runner, and chat route handlers stay provider- and OAuth-agnostic.
  - *Composition*: default provider registries, OAuth services, customer email adapters, repositories, and skill executors are assembled in `backend/src/app/composition/`.
- **Encapsulation Rule**:
  - OAuth must expose a narrow consumer port such as "start authorization", "complete callback", "get usable credential", "mark needs reauth", and "summarize connection"; it must not know email-specific send semantics.
  - Customer email must consume OAuth through that port; it must not parse callback state, own refresh logic, or store provider tokens directly.
  - Email skill definitions own product constraints such as draft/send mode and bound/exposed fields; provider adapters only know how to create drafts or send messages.
  - Non-secret configuration may be represented as workspace/agent settings data; OAuth tokens, client secrets, refresh tokens, and provider credentials must stay in encrypted secret storage.
- **New Seams Required**:
  - Reusable OAuth connection/token lifecycle module or extraction from the MCP OAuth implementation.
  - Workspace customer email connection service and repository.
  - Customer email provider adapter port for `createDraft` and `sendMessage` outcomes.
  - Email skill definition schema/registry entries and executor behind the existing skill port.
  - Activity/audit event mapper that redacts secrets and message bodies by default.
  - Workspace settings UI for connections and agent/routine UI for email skill definition/selection.
- **Anti-Goals**:
  - Do NOT add another OAuth implementation if MCP OAuth already provides the lifecycle needed here.
  - Do NOT expose a generic raw `email.send(to, subject, body)` primitive to every assistant turn.
  - Do NOT let the model select arbitrary provider APIs, scopes, accounts, or credentials.
  - Do NOT use customer email connections for Radioso product/system transactional email.
  - Do NOT build full inbox sync, email reading, contact management, campaigns, attachments, or marketing automation in this feature.
  - Do NOT build mail-provider spam prevention; customer providers own deliverability, quotas, reputation, and abuse enforcement. Radioso still enforces credential hygiene, allowlisted skills, validation, and audit.
  - Do NOT store OAuth tokens, message bodies, or provider error payloads in plaintext logs/traces.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide or reuse a provider-neutral OAuth substrate for third-party integration connections, including authorization start, callback completion, state validation, token storage, token refresh, and reauthorization status.
- **FR-002**: The OAuth substrate MUST store credential sets encrypted at rest and MUST never return access tokens, refresh tokens, client secrets, cookies, or raw provider credentials to clients.
- **FR-003**: The OAuth substrate MUST be reusable by modules other than customer email; specifically, this feature MUST align with the MCP OAuth implementation if it lands first.
- **FR-004**: Workspace operators MUST be able to create, list, inspect, disable, reauthorize, and delete customer-owned email connections without seeing secrets.
- **FR-005**: Customer email connections MUST be separate from Radioso-owned transactional mail and MUST NOT affect password reset, verification, invitation, or product/system email delivery.
- **FR-006**: Each customer email connection MUST expose a non-secret status that distinguishes at least unconfigured, authorized, disabled, needs reauthorization, and error.
- **FR-007**: Agent authors MUST be able to define named email skills over a workspace email connection.
- **FR-008**: Email skills MUST support draft mode and send mode, with draft mode available as the safer default.
- **FR-009**: Email skills MUST define required fields and whether each field is bound by the author or exposed for conversation/routine input.
- **FR-010**: Email skills MUST validate recipient, sender/reply-to, subject, and body inputs before provider calls.
- **FR-011**: Only defined, enabled email skills MAY be invoked by agents/routines; raw provider APIs and raw credentials MUST NOT be model-callable.
- **FR-012**: Routines MUST be able to invoke email skills through the existing skill/action execution spine and branch on stable outcomes.
- **FR-013**: Email skill outcomes MUST distinguish at least drafted, sent, missing input, disabled connection, needs reauthorization, provider rejected, and unexpected failure.
- **FR-014**: Provider calls MUST be bounded by timeouts and must fail safely into typed outcomes without blocking unrelated conversation handling indefinitely.
- **FR-015**: Deleting a customer email connection referenced by a skill MUST be blocked until references are removed or disabled.
- **FR-016**: Audit/activity records MUST capture skill name, connection id, agent/routine context, non-secret recipient metadata, outcome, and timestamp while redacting secrets and message body content by default.
- **FR-017**: System MUST document that customer provider spam, deliverability, and quota enforcement are delegated to the customer's provider, while Radioso controls credentials, skill allowlisting, validation, and audit.

### UI Tasks

- **Workspace OAuth/email connections**: list customer email connections; start OAuth authorization; show authorization/reauthorization status; disable, reauthorize, and delete connections; show provider identity and last health result without secrets.
- **Agent email skill builder**: select a workspace email connection; choose draft/send mode; name the skill; bind or expose recipient/subject/body/reply-to/template inputs; validate required fields.
- **Routine authoring**: select a defined email skill for a routine step; map routine slots to exposed inputs; show branchable outcomes.
- **Activity view**: show email skill invocations and sanitized outcomes.

### Key Entities

- **OAuth Connection**: Provider-neutral authorization record for a third-party integration. Attributes: provider type, workspace scope, authorization status, granted scopes, encrypted token set, refresh status, created/updated timestamps. Relationships: consumed by integration modules such as customer email and MCP/external skills.
- **Customer Email Connection**: Workspace-owned outbound email resource backed by an OAuth connection. Attributes: provider, sender identity, status, disabled flag, last health result. Relationships: referenced by Email Skill Definitions.
- **Email Skill Definition**: Agent-visible, allowlisted action over a customer email connection. Attributes: skill name, connection reference, draft/send mode, bound inputs, exposed inputs, enabled flag, outcome set.
- **Email Skill Run**: Runtime invocation record. Attributes: skill definition, agent/routine context, sanitized recipient metadata, provider outcome, timestamp, error code when applicable.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workspace operator can complete OAuth authorization for a supported mail provider and see an authorized customer email connection without any token being exposed in client responses.
- **SC-002**: The OAuth lifecycle tests pass against a mock provider for authorization, callback, refresh-before-use, and refresh-failure-to-reauth transitions.
- **SC-003**: The OAuth substrate is consumed through a reusable port, with no email-specific OAuth state-machine code and no duplicate OAuth implementation when MCP OAuth is available.
- **SC-004**: An agent author can define a draft-mode email skill and use it in a routine in under 5 minutes once a connection exists.
- **SC-005**: A routine invoking an email skill follows the correct branch for drafted/sent, missing input, disabled, needs-reauth, and provider-rejected outcomes in 100% of focused tests.
- **SC-006**: Radioso password reset and verification email continue to use Radioso-owned transactional mail configuration after a customer email connection is added.
- **SC-007**: Logs, audit events, and traces for email skill runs contain no OAuth tokens, refresh tokens, client secrets, cookies, connection strings, or full message bodies by default.

## Assumptions

- **OAuth first**: The first customer email connection path is OAuth. Static SMTP credentials and API-key mail providers are out of scope for the first delivery unless added in planning.
- **MCP OAuth alignment**: MCP OAuth work is expected to land before or near this feature. This spec requires reuse/extraction of that OAuth lifecycle where possible.
- **Provider support**: The feature needs at least one supported OAuth mail provider end-to-end plus mock-provider tests. The architecture must allow additional providers without changing skill/routine execution.
- **Skill scope**: Email skills are agent-visible allowlisted actions. Workspace-level connections may be reused by multiple agents if permissions allow.
- **Message retention**: Full email body retention is off by default. Activity stores sanitized metadata and outcomes.
- **Spam/deliverability**: Customer mail providers enforce spam, quota, reputation, and deliverability policy. Radioso does not attempt to replace those controls.

## Cross-Cutting Reviews *(mandatory per constitution)*

- **Code-First API Contracts (VIII)**: New backend routes for OAuth start/callback/status, customer email connection CRUD, email skill definition CRUD, and skill activity MUST be defined in the code-first OpenAPI registry with Zod schemas; generated OpenAPI artifacts MUST be regenerated, not hand-edited.
- **Message-Queue Impact Review**: The first feature is expected to execute draft/send requests synchronously through the skill/action runtime with provider timeouts. It does not change document worker dispatch, AMQP queue payloads, or retry semantics. If planning adds deferred email delivery, it MUST define queue payloads, retry semantics, and queue contract tests/docs.
- **Documentation Parity (IX)**: Update docs for workspace email setup, OAuth authorization/reauthorization, email skill authoring, routine outcomes, and the separation between Radioso transactional email and customer-owned email. Read `docs/document-writer-prompt.md` before editing docs.
- **Prompt Asset Ownership (X)**: If implementation introduces model-assisted field extraction or classification prompts, runtime prompt assets MUST live under `backend/prompts/`.
- **Secrets/Config (IV)**: Update `.env.example` for any OAuth client/provider configuration and encryption requirements. Never commit secrets.
- **Observability Review**: Add low-cardinality metrics/spans/audit events for OAuth authorization outcomes, token refresh outcomes, email skill provider outcomes, and reauthorization needs. Do not log raw prompts, completions, document content, email bodies, tokens, credentials, cookies, or connection strings.
