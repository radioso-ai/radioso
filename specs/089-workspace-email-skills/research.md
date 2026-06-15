# Research: Workspace Email Connections and Skills

## Decision: reuse or extract the MCP OAuth lifecycle

**Decision**: Treat the MCP OAuth implementation as the source of truth for OAuth lifecycle behavior. The full implementation from `origin/087-external-skills-oauth` / `upstream/087-external-skills-oauth` at `c7de743a6` has been merged into this workspace. If it is generic enough, customer email consumes it through a provider-neutral port. If it is embedded in MCP-specific services, extract the shared lifecycle into a neutral module before adding email behavior.

**Rationale**: Building email OAuth in parallel would create duplicate state machines for authorization, callback state, token refresh, encryption, and reauthorization.

**Concrete reuse/extraction targets**:

- `backend/src/modules/externalSkills/oauth/oauthClient.ts`: PKCE S256 generation, OAuth state, authorization URL, authorization-code exchange, refresh-token exchange, expiry checks.
- `backend/src/modules/externalSkills/oauth/oauthCrypto.ts`: encrypted JSON helpers over existing field encryption.
- `backend/src/modules/externalSkills/oauth/oauthAccessTokenResolver.ts`: call-time access token resolution, refresh-before-use, and `needs_reauth` transition.
- `backend/src/modules/externalSkills/services/mcpConnectionService.ts`: MCP-specific orchestration for connection config, authorization start, callback completion, and logging. Extract protocol-neutral pieces; do not make customer email depend on MCP connection semantics.

**Alternatives considered**:

- Build email-owned OAuth now: rejected because it duplicates MCP OAuth and violates the spec boundary.
- Put email OAuth inside `customerEmail`: rejected because future modules would have to duplicate or depend on email.
- Wait to plan anything until MCP OAuth is visible on this branch: rejected because the OAuth branch is available and the reusable extraction boundary is now concrete.

## Decision: customer email is separate from Radioso transactional mail

**Decision**: Keep `backend/src/modules/mail/` as Radioso-owned system transactional delivery. Add customer-owned email in a separate module, tentatively `backend/src/modules/customerEmail/`.

**Rationale**: Password reset and verification require system reliability and product-owned templates. Customer email skills are customer-authorized side effects with different credentials, audit, skill definitions, and runtime outcomes.

**Alternatives considered**:

- Extend `EmailService` with customer credentials: rejected because it blurs system mail and customer mail and risks using customer providers for product transactional flows.
- Add provider logic directly to skills/routines: rejected because routines must stay provider-agnostic.

## Decision: workspace connection, agent skill

**Decision**: Customer email connections are workspace-scoped resources; email skills are agent-visible definitions referencing a workspace connection.

**Rationale**: Email accounts belong to the workspace/operator, while skills define how a specific agent/routine may use that connection. This allows one connection to support multiple constrained skills without duplicating OAuth credentials.

**Alternatives considered**:

- Per-agent email connections only: rejected because it duplicates provider authorization across agents and makes rotation harder.
- Global app-wide email connections: rejected because customer-owned credentials must be workspace-scoped.

## Decision: draft mode and send mode are explicit skill configuration

**Decision**: Email skills support `draft` and `send` modes. Draft mode must be available as the safer default; send mode is explicitly configured by the author.

**Rationale**: Draft mode supports broad assistant workflows with review. Send mode is still valid for narrow routines where the customer intentionally authorizes a side effect.

**Alternatives considered**:

- Draft-only first slice: rejected as too limited for routine automation.
- Send-only primitive: rejected because it removes the safer review path.

## Decision: typed outcomes instead of raw provider errors

**Decision**: Email skill execution maps provider behavior to typed outcomes: `drafted`, `sent`, `missing_input`, `disabled_connection`, `needs_reauth`, `provider_rejected`, and `failed`.

**Rationale**: Routines branch on stable product outcomes, not provider-specific HTTP errors. Sanitized outcomes also keep credentials and provider payloads out of user-facing errors.

**Alternatives considered**:

- Expose raw provider errors to routines: rejected because it leaks provider semantics and can include sensitive details.
- Collapse all failures to one failure: rejected because reauthorization and missing-input cases require different operator/routine handling.

## Decision: no queue in the first slice

**Decision**: The first implementation runs draft/send through the skill executor with bounded timeouts and typed outcomes. It does not add worker/AMQP payloads.

**Rationale**: Existing external skills run synchronously through the skill port. Matching that model keeps the first slice small and avoids inventing delivery retry semantics before product need is proven.

**Alternatives considered**:

- Outbox/worker delivery: useful later for guaranteed delivery or large sends, but not required for first customer email skills.
- Fire-and-forget provider call: rejected because routines need branchable outcomes.

## Decision: provider spam and deliverability are delegated

**Decision**: Customer mail providers own spam, deliverability, quotas, and reputation enforcement. Radioso still enforces credential encryption, explicit skill allowlisting, validation, typed outcomes, and audit.

**Rationale**: The sender is the customer's provider account. Duplicating anti-spam provider behavior in Radioso would add product scope without replacing provider controls.

**Alternatives considered**:

- Build Radioso spam controls: rejected for this feature; only lightweight validation and explicit skill constraints are in scope.

## Open Implementation Selection: first real provider

**Decision needed during implementation planning**: Choose Gmail or Microsoft 365 as the first real provider, plus mock provider tests.

**Rationale**: The architecture can support either. The first provider choice affects OAuth scopes, draft API semantics, sender identity validation, and docs.

**Recommended default**: Gmail if the goal is a quick consumer/business account path; Microsoft 365 if the target customer base is enterprise support/sales teams.
