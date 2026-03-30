# Feature Specification: Security Remediation

**Feature Branch**: `031-security-remediation`  
**Created**: 2026-03-30  
**Status**: Draft  
**Input**: User description: "Remediate confirmed repository security vulnerabilities: reachable dependency advisories, fail-closed connector secret encryption, browser bearer token storage, and durable auth and anonymous chat abuse controls."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Protect Stored Credentials and Sessions (Priority: P1)

As a workspace administrator, I need connector secrets and workspace access credentials to remain protected even when a deployment is misconfigured or a browser environment is compromised, so that a single mistake does not expose long-lived access to customer data.

**Why this priority**: The highest-impact findings are secret exposure and reusable credential theft. Those create account- and workspace-wide compromise paths rather than isolated failures.

**Independent Test**: Can be fully tested by configuring connectors, signing in, switching workspaces, and verifying that secrets are not newly stored plaintext and that browser storage no longer exposes reusable workspace bearer tokens.

**Acceptance Scenarios**:

1. **Given** connector secrets are being saved, **When** the deployment lacks required encryption configuration, **Then** the system rejects the unsafe operation with a clear operator-facing failure instead of silently storing plaintext.
2. **Given** an administrator signs in and uses multiple workspaces, **When** the browser session is established, **Then** the browser does not retain reusable workspace bearer credentials in persistent client storage.
3. **Given** an operator already has stored connector configuration from an earlier deployment, **When** the hardened release is applied, **Then** the system provides a defined migration or recovery path instead of leaving the safety state ambiguous.

---

### User Story 2 - Resist Common Abuse and Denial Attempts (Priority: P1)

As an operator responsible for availability and customer data protection, I need authentication, token issuance, uploads, and anonymous chat entry points to enforce durable abuse controls, so that scripted guessing and flood traffic cannot cheaply exhaust the system.

**Why this priority**: These routes are externally reachable and directly connected to account takeover, resource exhaustion, and public abuse scenarios.

**Independent Test**: Can be fully tested by sending repeated login, token-issuance, upload, and anonymous chat requests and verifying that limits apply consistently and remain effective across process restarts or multi-instance deployment behavior.

**Acceptance Scenarios**:

1. **Given** repeated failed sign-in or registration attempts from the same actor, **When** requests exceed the allowed threshold, **Then** the system denies additional attempts for the documented cooldown window and records the event for operators.
2. **Given** repeated requests to mint or retrieve workspace access credentials, **When** requests exceed the allowed threshold, **Then** the system blocks further issuance attempts instead of allowing unlimited retries.
3. **Given** anonymous chat traffic is distributed across multiple runtime instances or the service restarts, **When** a caller exceeds the configured threshold, **Then** the effective limit still holds rather than resetting per process.

---

### User Story 3 - Remove Reachable Known Vulnerabilities (Priority: P2)

As a maintainer, I need the production dependency graph and externally reachable request handling paths to be free of the confirmed known advisories from the audit, so that the platform is not left exposed to already-documented exploits.

**Why this priority**: Confirmed advisories are less ambiguous than speculative hardening work, but they follow the credential and abuse fixes because some may require migration or dependency replacement choices.

**Independent Test**: Can be fully tested by updating the production dependency graph, exercising the affected upload and routing flows, and verifying that the documented advisories no longer appear in audit output or are explicitly contained with an approved compensating control.

**Acceptance Scenarios**:

1. **Given** the document import capability remains available, **When** supported file types are processed after remediation, **Then** the service no longer depends on the known vulnerable spreadsheet parsing path in production.
2. **Given** API routes continue to serve the same documented behavior, **When** the backend starts on the remediated dependency set, **Then** the confirmed vulnerable route-matching package path is removed or replaced.
3. **Given** the frontend remains on its supported framework version, **When** the application is built and audited, **Then** the confirmed framework advisories from the audit are resolved or explicitly superseded by a supported patched release.

---

### User Story 4 - Preserve Safe Operations During Rollout (Priority: P3)

As an operator deploying the remediation, I need explicit rollout, migration, and fallback guidance, so that security fixes do not leave existing workspaces, connectors, or sessions in an unknown state.

**Why this priority**: Security work often fails in rollout rather than code correctness. A clear operating model reduces the chance of reverting fixes under pressure.

**Independent Test**: Can be fully tested by following the documented upgrade path in a non-production environment with existing sessions and connector records and confirming that operators can complete the upgrade without manual data guessing.

**Acceptance Scenarios**:

1. **Given** an environment has existing connector configuration and active sessions, **When** the remediation is deployed, **Then** operators receive clear guidance on which values must be present before startup and what happens to pre-existing state.
2. **Given** one remediation slice cannot be completed safely in the same release, **When** the team reviews the rollout plan, **Then** the spec identifies the compensating control and the temporary residual risk explicitly.

### Edge Cases

- What happens when existing connector secrets were previously saved without encryption and the operator enables the new hardened behavior for the first time?
- How does the system handle active browser sessions created before the new workspace credential model is introduced?
- What happens when a legitimate administrator triggers rate limits during a migration, smoke test, or incident response workflow?
- How does the system behave when a dependency upgrade removes or changes behavior in file import, auth, or streaming routes?
- What happens when anonymous chat is disabled and later re-enabled after rate-limiter state already exists?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes and middleware own request validation, auth attachment, and response shaping; auth, connector, and abuse-control services own security policy; repositories and persistence adapters own storage details; frontend session/bootstrap code owns client state transitions but MUST NOT become the source of truth for reusable credentials.
- **Encapsulation Rule**: `backend/src/app/http/routes/*` must remain transport-only; `backend/src/app/server/dependencies.ts` must remain composition-only; `frontend/lib/api.ts` must not continue to be the long-term store for reusable workspace credentials; connector plugins must not each invent their own encryption or abuse-control behavior.
- **New Seams Required**: A focused credential/session ownership seam for workspace access, a reusable abuse-control service or store-backed limiter for auth and anonymous routes, and a dedicated migration path for pre-existing plaintext or legacy connector config records if they exist.
- **Anti-Goals**: Do not scatter rate limiting independently across route files without a shared policy; do not keep plaintext connector-secret fallback behavior; do not patch around vulnerable dependencies while preserving the same unsafe library path; do not solve browser token theft by adding more client-side obfuscation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST eliminate the confirmed reachable high-severity production dependency advisories identified in the audit or document an explicit temporary compensating control and planned follow-up if a direct package upgrade is not safely available in the same release.
- **FR-002**: System MUST reject new connector secret writes when required secret-encryption configuration is absent or invalid, rather than silently storing secret values in plaintext.
- **FR-003**: System MUST define and implement a deterministic handling path for connector configurations created before secret-encryption hardening, including how operators discover, recover, or rotate affected records.
- **FR-004**: System MUST stop persisting reusable workspace bearer credentials in persistent browser storage.
- **FR-005**: System MUST preserve the ability for signed-in administrators to use multiple workspaces after the credential-storage change without requiring unsafe manual token handling.
- **FR-006**: System MUST apply abuse controls to login, registration, workspace credential issuance, and authenticated upload routes using thresholds and cooldown behavior that are documented and testable.
- **FR-007**: System MUST apply abuse controls to anonymous chat using shared durable state so that enforcement remains effective across process restarts and multi-instance deployments.
- **FR-008**: System MUST fail safely when abuse-control state is unavailable, with a documented behavior that prefers customer-data protection and service predictability over silent bypass.
- **FR-009**: System MUST preserve existing documented API behaviors unless a contract change is required for the safer credential model, in which case the code-first OpenAPI registry and generated artifacts MUST be updated together.
- **FR-010**: System MUST produce operator-facing configuration guidance for any new required environment values, migration steps, or rollout dependencies introduced by the remediation.
- **FR-011**: System MUST record security-relevant remediation outcomes, including blocked unsafe secret writes and rate-limit enforcement events, in a way operators can audit.
- **FR-012**: System MUST include regression coverage for dependency remediation behavior, credential-storage behavior, secret-encryption hardening, abuse-control enforcement, and any migration path introduced by the change.

### Key Entities *(include if feature involves data)*

- **Workspace Access Session**: The authenticated state that allows an administrator to act within one or more workspaces without exposing long-lived reusable credentials to browser storage.
- **Connector Secret Record**: A connector configuration entry that may contain sensitive values requiring safe-at-rest handling, validation, migration awareness, and operator-visible failure modes.
- **Abuse-Control Policy**: The configured limit, scope, and enforcement window applied to login, token issuance, upload, and anonymous chat traffic.
- **Legacy Security State**: Previously created sessions or stored connector values that predate the remediation and therefore require migration or explicit invalidation behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Confirmed production dependency advisories from the initial audit are reduced to zero high-severity findings and zero unresolved framework advisories on supported release lines, or each exception has an approved written compensating control.
- **SC-002**: In validation, 100% of attempts to save connector secrets without valid encryption configuration fail safely and leave no newly written plaintext secret values behind.
- **SC-003**: In validation, 100% of authenticated browser flows operate without reusable workspace bearer credentials being present in persistent browser storage after sign-in and workspace switching.
- **SC-004**: In validation, 100% of scripted abuse tests against login, registration, token issuance, uploads, and anonymous chat enforce the documented thresholds and cooldown behavior.
- **SC-005**: Operators can complete the documented rollout and migration steps in a staging environment without requiring undocumented manual database edits.
