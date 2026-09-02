# Feature Specification: Workspace and Agent API Credentials

**Feature Branch**: `role-based-mcp-access-design` (Conductor workspace; feature ID `1117-api-access-tokens`)
**Created**: 2026-08-31
**Status**: Approved
**Approved**: 2026-09-01 (agent-channel credential scope approved)
**Input**: Replace the single shared workspace administrator token with role-bounded personal API tokens and first-class workspace service accounts, then give MCP and REST clients separate per-agent credentials that can interact with chat without receiving workspace member or administrator authority.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mint a Personal API Token (Priority: P1)

As a workspace user, I can create a personal API token for my own integrations without asking an administrator to reveal or share a workspace-wide secret. I choose a name, a role ceiling that does not exceed my current workspace access, and an expiry. The secret is shown once so I can store it in my client or secret manager.

**Why this priority**: Personal tokens remove the need to share an administrator credential and make API activity attributable to an individual user.

**Independent Test**: Sign in as a member, create a member personal token, copy the one-time secret, and use it on an allowed workspace API while confirming that an administrator-only API is denied.

**Acceptance Scenarios**:

1. **Given** a signed-in workspace member, **When** the member creates a personal token with a valid name and expiry, **Then** the system returns the new secret exactly once and subsequently lists only safe token metadata.
2. **Given** a signed-in administrator, **When** the administrator creates a personal token, **Then** they may choose either a member or administrator ceiling, but never owner authority.
3. **Given** a member personal token and no valid session cookie, **When** the token calls an operation outside the member role, **Then** the request is denied even if its owner has broader access in another workspace.
4. **Given** any personal token, **When** another user or an administrator attempts to reveal, rename, or rotate it, **Then** the operation is denied; an administrator may only inspect safe metadata and revoke it.

---

### User Story 2 - Create a Workspace Service Account (Priority: P1)

As a workspace owner or administrator, I can create a named service account for CI, a backend integration, or another unattended workload, assign its workspace role, and issue one or more expiring credentials to it. The service account is the durable non-human identity; its credentials are replaceable secrets. It therefore keeps one audit identity across deployments and credential changes and continues when its creator leaves.

**Why this priority**: Unattended integrations need an identity independent of an employee and independent of any one secret. Treating each token as the identity would fragment audit history and make disabling, changing the role of, or rotating one integration needlessly difficult.

**Independent Test**: Create a member service account with two credentials, authenticate with both as the same service principal, revoke one without affecting the other, change the service account role, disable it, and confirm that every credential follows the live principal state.

**Acceptance Scenarios**:

1. **Given** a signed-in owner or administrator, **When** they create a service account, **Then** they must supply a display name and assign a member or administrator role no higher than their own effective role.
2. **Given** a service account, **When** an owner or administrator issues two credentials for different deployments, **Then** both authenticate as the same service principal while retaining distinct credential identifiers, prefixes, expiry, and last-use metadata.
3. **Given** two active credentials for one service account, **When** one is revoked, **Then** only that credential fails and the other remains valid.
4. **Given** an active service account, **When** its role is changed, **Then** every credential uses the new role on its next request.
5. **Given** an active service account, **When** it is disabled, **Then** all credentials are suspended immediately; deliberate re-enablement restores only credentials that remain unexpired and unrevoked.
6. **Given** a service account, **When** it is archived, **Then** all credentials are permanently invalidated, the account cannot be re-enabled, and its non-secret audit identity remains available.
7. **Given** an active service account, **When** its creator loses workspace access, **Then** the service account and credentials remain active and manageable by another owner or administrator.
8. **Given** a signed-in ordinary member, **When** they attempt any service-account or service-credential lifecycle operation, **Then** the request is denied.

---

### User Story 3 - Enforce Live, Role-Bounded Access (Priority: P1)

As a workspace operator, I can rely on the same centralized workspace roles for browser sessions, personal tokens, and service accounts. A personal token may lower but never raise its user's live role; a service credential always derives authority from its live service account. Sensitive identity and credential operations remain session-only.

**Why this priority**: Issuing more credentials is safe only if tokens cannot bypass the platform's role model or acquire authority through a second, drifting scope system.

**Independent Test**: Exercise the same representative member and administrator operations using a browser session, personal token, and service credential, then verify the documented role parity, live principal changes, and session-only denials.

**Acceptance Scenarios**:

1. **Given** a personal token with an administrator ceiling whose owner is demoted to member, **When** the token makes its next request, **Then** its effective authority is reduced to member immediately.
2. **Given** a personal token whose owner's active account membership ends, whose user is deleted, or whose workspace is deleted, **When** it is used again, **Then** it is permanently invalid and is not revived if the user is later re-added.
3. **Given** a personal token created with a member ceiling whose owner is later promoted, **When** the token is used, **Then** it remains limited to member authority until the user creates a replacement with a different ceiling.
4. **Given** a personal or service credential, **When** it is presented to a public launch, agent-converse, account, organization, membership, credential-lifecycle, service-account-management, or other session-only surface without a session cookie, **Then** authentication or authorization is denied without falling back to broader workspace access.
5. **Given** a public launch credential or an agent-converse credential, **When** it is presented as a normal API bearer token, **Then** it is rejected.

---

### User Story 4 - Replace the Shared Administrator Token Safely (Priority: P1)

As a self-hosted operator upgrading Radioso, I receive a direct security migration from the legacy shared administrator token to personal credentials and workspace service accounts. The old credential and any API-token-backed MCP sessions are invalidated immediately because backward compatibility is not required at this stage.

**Why this priority**: Preserving a legacy credential that was broadly revealable would carry the original privilege-escalation risk into the new model.

**Independent Test**: Upgrade a workspace with an active legacy token and MCP session, verify that both fail immediately and all recoverable/authenticating material is removed, then sign in as an administrator and create a service account and new API credential.

**Acceptance Scenarios**:

1. **Given** an installation with a legacy workspace token, **When** the upgrade migration runs, **Then** its ciphertext, verifier/hash, and every other authenticating value are transactionally destroyed and a mandatory non-secret audit tombstone is recorded.
2. **Given** an active API-token-backed MCP session, **When** the upgrade runs, **Then** destruction of the backend verifier makes the session unusable on its next upstream request, and every MCP runtime store configured as part of the upgraded installation purges its stored copy before becoming ready.
3. **Given** a destroyed legacy token, **When** it is used on any API or MCP endpoint, **Then** it receives the same non-enumerating invalid-credential response as an unknown token.
4. **Given** a signed-in owner or administrator after upgrade, **When** they open API access settings, **Then** the UI explains the breaking change and lets them create a personal token or service account and credential without revealing any legacy secret.
5. **Given** an interrupted or repeated migration, **When** it resumes, **Then** it completes idempotently without restoring a credential, issuing duplicates, or losing the audit tombstone.
6. **Given** an operator preparing the upgrade, **When** they read the release guidance, **Then** it states that legacy API and MCP integrations stop immediately and must be reconfigured after upgrade, and that application downgrade requires restoring a compatible database backup.

---

### User Story 5 - Manage Principals and Credential Lifecycles (Priority: P2)

As a token owner or workspace administrator, I can identify active principals and credentials and deliberately replace, suspend, archive, or revoke them without exposing secrets. Expiry and last-use metadata help me remove credentials that are no longer needed.

**Why this priority**: Ongoing inventory and revocation are required to keep multiple credentials safer than the shared token they replace.

**Independent Test**: Manage a personal token and a service account with multiple credentials, verify credential-level revocation and principal-wide disable behavior, and confirm that lifecycle and representative API actions remain attributable to both the stable principal and the specific credential.

**Acceptance Scenarios**:

1. **Given** a signed-in user, **When** they view API access settings, **Then** they see their personal tokens and may relabel, rotate, or revoke them, but never reveal them.
2. **Given** a signed-in owner or administrator, **When** they view service accounts, **Then** they see safe principal and per-credential metadata and may rename the account, change its role, disable, re-enable, or archive it, and issue, relabel, rotate, or revoke its credentials.
3. **Given** a signed-in owner or administrator, **When** they view personal-token inventory, **Then** they may see safe owner and lifecycle metadata and revoke a token, but cannot reveal or rotate its secret.
4. **Given** an immediate credential rotation, **When** rotation succeeds, **Then** the predecessor is invalid immediately, the replacement retains its principal binding and absolute expiry time, audit continuity remains attached to that principal, and the new secret is shown exactly once.
5. **Given** a revoked or expired credential, **When** any user attempts to rotate or use it, **Then** it remains invalid and cannot be revived.
6. **Given** two rotations submitted against the same active credential revision, **When** they race, **Then** exactly one returns a replacement secret and every loser receives a conflict response without creating or revealing another credential.
7. **Given** an issuance or rotation response that is lost after success, **When** the user returns to inventory, **Then** they can identify the inaccessible active credential by safe metadata and rotate or revoke it; the original secret remains unrecoverable.
8. **Given** a service integration that needs zero-downtime replacement, **When** an administrator issues an additional credential, deploys it, and revokes the predecessor, **Then** both credentials overlap only for the administrator-controlled deployment interval and every request remains attributed to the same service account.

---

### User Story 6 - Configure API Access Without Confusing Credential Types (Priority: P2)

As an operator, I can distinguish personal tokens, service accounts and their credentials, public launch credentials, and agent channel credentials in the product and documentation, so I choose the correct identity and credential for each integration.

**Why this priority**: Similar-looking secrets serve different trust boundaries; unclear naming leads to accidental overexposure and failed integrations.

**Independent Test**: Follow the dashboard and documentation to create a personal token and a service account credential, then create separate MCP and REST credentials on an agent and verify that every credential is presented with its distinct purpose.

**Acceptance Scenarios**:

1. **Given** a user opening workspace settings, **When** the page loads, **Then** personal tokens remain on the workspace page and service accounts have their own Settings page with concise guidance on when to use each.
2. **Given** a newly created or rotated token, **When** its one-time secret screen is shown, **Then** the UI requires acknowledgement that it cannot be recovered and provides copy-ready configuration guidance without persisting the secret in browser storage.
3. **Given** a user reading API or SDK documentation, **When** they follow an example, **Then** it describes a personal token or service-account credential and does not direct them to retrieve a shared workspace secret.
4. **Given** a public launch or agent-channel setup flow, **When** credentials are displayed, **Then** they are not labelled as personal tokens or service-account credentials and are not described as interchangeable bearer credentials.

---

### User Story 7 - Connect an External Client to One Agent (Priority: P1)

As a workspace administrator, I can create a credential for an MCP client or a REST integration that is bound to one agent and can only run that agent's chat experience. The credential has no member or administrator role, so exposing it to a customer-facing client does not expose workspace administration.

**Why this priority**: Chat is a narrow runtime channel, not a workspace identity. Reusing personal or service-account authority would unnecessarily expose documents, settings, agent authoring, skills, routines, and other workspace operations.

**Independent Test**: Create one MCP credential and one REST credential for an agent, chat successfully through each transport, then prove that the credentials cannot be swapped between transports, cannot select another agent, cannot call a workspace API, and stop immediately after rotation or revocation.

**Acceptance Scenarios**:

1. **Given** an administrator managing an agent's Channels page, **When** they create an MCP or REST credential, **Then** the secret is shown once and the safe inventory records its audience, label, prefix, creation time, expiry, last use, and revocation state without a workspace role.
2. **Given** a valid REST agent credential, **When** it calls `POST /api/v1/agents/{agentId}/chat` for its bound agent, **Then** the normal stateful agent turn loop runs with that agent's persona, directives, skills, and routines.
3. **Given** a valid MCP agent credential, **When** the MCP client connects, **Then** its catalogue contains the stateful agent chat tool and does not expose direct retrieval, raw document resources, workspace administration, Ray, or skill-catalogue management.
4. **Given** an MCP credential used on REST, a REST credential used on MCP, or either credential used with another agent ID, **When** authentication runs, **Then** the request receives the same non-enumerating invalid-credential response as an unknown credential.
5. **Given** a valid agent channel credential, **When** it is presented to any ordinary workspace, account, settings, document, retrieval, agent-authoring, skill, routine, provider, membership, or credential-lifecycle route, **Then** it is denied without acquiring member or administrator authority.
6. **Given** a channel credential is rotated or revoked, **When** the previous secret or any derived MCP session is used again, **Then** it fails on the next authorization check while the replacement remains bound to the same agent and audience.
7. **Given** a user with agent-management permission, **When** they create, rotate, or revoke a channel credential, **Then** the user's live workspace role authorizes that lifecycle action but is not copied onto the issued credential.

### Edge Cases

- Concurrent create requests MUST produce distinct credentials and independently manageable records.
- Service-account names and credential labels are display text, not identifiers or authorization inputs. Duplicates are allowed and are distinguished by stable IDs and safe credential prefixes.
- Names and labels are trimmed and Unicode-normalized, contain 1–80 Unicode characters, and reject line breaks and control characters while accepting other international text.
- A personal token request spanning a role change is authorized using the effective access established at the start of that request; every later request uses the new access state.
- Ending a user's continuous access tenure permanently invalidates all personal tokens bound to that tenure. A later re-invitation creates a new tenure and never revives old tokens.
- Deleting a workspace invalidates all personal tokens, service accounts, and service-account credentials in it.
- A service account remains valid when its creator leaves. A credential remains usable only while the service account is enabled and the credential is unexpired and unrevoked.
- Re-enabling a disabled service account restores only credentials that independently remain active; archiving is permanent and restores none.
- Repeating a completed revoke is safe and does not restore or duplicate the credential. A rotation is conditional on the active credential revision; after one request wins, every competing request against the prior revision fails with a conflict and returns no secret.
- A credential that expires during a long-running request is rejected on the next authentication check; expiration does not reveal whether it otherwise matched a workspace.
- Per-credential and service-account aggregate last-used metadata may lag successful use by up to five minutes, but MUST never advance for a rejected request.
- The UI MUST not cache one-time secrets in local storage, session storage, logs, analytics, or later API responses.
- Personal tokens and service-account credentials MUST be rejected by every MCP endpoint. MCP accepts only an MCP-audience credential bound to one agent; REST agent chat accepts only a REST-audience credential bound to that same path agent.
- Agent channel credentials MUST never select a workspace default agent, cross agents, cross audiences, or fall through to ordinary workspace bearer authentication.
- Destroying the backend verifier MUST invalidate every legacy API-token-backed MCP session on its next upstream request. Runtime stores controlled by the upgraded installation MUST also purge stored copies before reporting ready; stale external MCP deployments cannot be erased remotely, but their copies remain unusable.
- Inventory requests MUST remain bounded and paginated, and attempts to exceed active principal or credential limits MUST fail without creating partial records or secrets.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated only if this feature introduces operator configuration.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Public API contract changes MUST ship with the regenerated TypeScript SDK snapshot and matching SDK behavior.
- Setup, authentication, REST API, SDK, and affected MCP documentation MUST be updated in the same change after reading the repository's documentation-writing guidance.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: A focused machine-access domain owns service-account identity and state, personal and service credential lifecycle, expiry, rotation lineage, and authenticated-principal construction. Account access remains the single authority for role-to-permission mapping. HTTP handlers own transport only, persistence adapters own storage and lookup only, and application composition wires these pieces with audit and observability.
- **Encapsulation Rule**: `AccountAccessService` MUST remain the role and permission authority; it MUST NOT learn token persistence or secret generation. `AuthService` MUST authenticate a presented bearer credential and coordinate principal resolution without absorbing token inventory, migration, or dashboard workflows. Workspace-token repositories MUST NOT make authorization decisions. Frontend API clients and settings components MUST NOT persist or silently re-fetch a one-time secret.
- **New Seams Required**: Planning MUST identify focused boundaries for service-principal lifecycle, workspace credential lifecycle, continuous-access-tenure binding, workspace authenticated-principal resolution, destructive legacy migration, agent channel credential lifecycle, and expected-audience authentication. Token-use metadata updates MUST remain separate from request authorization so metadata failure cannot grant access or fail an otherwise authorized request.
- **Dependency Direction**: Transport and composition may depend on machine-access, account-access, access-grant, and chat ports. The machine-access domain may depend on narrow role/access and persistence contracts, but MUST NOT depend on HTTP, frontend, MCP tool definitions, or application composition. The access-grant domain owns agent/audience binding and secret lifecycle but MUST NOT know workspace roles, chat behavior, MCP tool catalogues, or UI copy. HTTP and MCP authenticate an expected audience before calling the existing chat service; chat MUST NOT authenticate credentials.
- **Anti-Goals**: Do not add a second per-token `scopes[]` permission system; do not reuse agent-bound access grants as workspace API tokens; do not put lifecycle logic in account routes, MCP mounts, chat orchestration, or the existing workspace authentication service; do not preserve encrypted recoverable secrets for new tokens; do not add token-management tools to Ray; do not expose the skill catalogue; and do not make public launch or channel credentials valid as ordinary workspace bearer tokens.
- **Contract and Queue Review**: The session-authenticated lifecycle REST contract and the generated TypeScript SDK snapshot are in scope. The published bearer-authenticated SDK MUST support using a token but MUST NOT claim to mint or manage tokens unless a separate session-authentication capability is designed. Document-worker and AMQP payloads are expected to be unaffected because tokens are authenticated at request entry points and are not propagated as worker contracts; planning MUST verify and record that conclusion.
- **Observability Rule**: Principal and credential lifecycle actions MUST emit audit events with actor, workspace, principal kind and ID, credential ID where applicable, role, safe reason, timestamps, outcome, and correlation data. Every audited API action performed with a credential MUST carry the stable user or service principal and the specific credential ID. Authentication MUST expose low-cardinality success/denial/expiry/revocation signals suitable for operations. Metrics labels MUST never contain names, IDs, prefixes, or other unbounded values. Logs, traces, metrics, analytics, and audit records MUST never retain the original credential, stored verifier, authorization header, prompts, completions, document content, retrieved chunks, cookies, or connection strings. Every MCP runtime store controlled by the upgraded installation MUST report safe purge success or fail readiness closed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST replace the single recoverable workspace administrator token with two API credential bindings: personal credentials bound to an existing user and continuous access tenure, and service credentials bound to a first-class workspace service account.
- **FR-002**: A signed-in workspace user MUST be able to create a personal token only for themself and only in a workspace they can currently access.
- **FR-003**: A personal token MUST store a declared member or administrator role ceiling that cannot exceed the creator's effective workspace role at creation; owner authority MUST never be assignable to an API credential or service account.
- **FR-004**: A personal token's effective role on every request MUST follow the settled matrix in this specification after `AccountAccessService` has resolved account membership and workspace grants into one current effective role.
- **FR-005**: Every personal token MUST bind to the immutable identifier of the owner's current continuous workspace access tenure. Ending the active account membership, deleting the user, or deleting the workspace MUST atomically end that tenure and permanently revoke its personal tokens. Workspace-grant removal, demotion, or other role changes within a continuing active account membership MUST preserve the tenure and token while recomputing its effective role. Re-invitation after membership removal MUST create a new tenure and MUST NOT revive tokens from an ended tenure.
- **FR-006**: A signed-in workspace owner or administrator MUST be able to create a workspace-owned service account with a stable identity, display name, and live member or administrator role no greater than the acting user's effective workspace role. A service account is non-human: it MUST NOT have an email, password, interactive login or browser session, account membership, or owner authority; it authenticates only through its issued service credentials.
- **FR-007**: A service account MUST remain independent of its creator's continued access. It MUST support live rename, role change, disable, re-enable, and permanent archive. Disable suspends all credentials; re-enable restores only otherwise-active credentials; archive permanently invalidates every credential while retaining non-secret audit identity.
- **FR-008**: Ordinary members MUST NOT create, list, change, disable, enable, archive, or issue credentials for service accounts. An owner or administrator MUST NOT assign or elevate a service account above their own effective role.
- **FR-009**: Personal-token, service-account, and service-credential lifecycle operations MUST require an authenticated interactive user session, CSRF protection, and explicit confirmation for secret issuance, immediate rotation, role elevation, revocation, disable, and archive. These operations MUST have no bearer-authentication fallback; a bearer credential alone can never manage principals or credentials.
- **FR-010**: A user MUST be able to list, relabel, rotate, and revoke their own personal tokens. A workspace owner or administrator MUST be able to list safe metadata for and revoke any personal token in the workspace, but MUST NOT reveal, relabel, rotate, or assume ownership of another user's token.
- **FR-011**: A workspace owner or administrator MUST be able to list and manage service accounts and issue, list, relabel, immediately rotate, and revoke multiple independently active credentials beneath each service account.
- **FR-012**: Personal-token creation and service-credential issuance or rotation MUST return a cryptographically strong opaque secret exactly once. The system MUST retain only a non-reversible verifier and safe identifying prefix needed for authentication and inventory. If that response is lost, the secret remains unrecoverable; inventory MUST let the authorized user identify and rotate or revoke the inaccessible credential.
- **FR-013**: No list, detail, audit, log, analytics, support, recovery, MCP session, or runtime-store surface MUST return, reconstruct, or persist an original personal or service credential or its verifier after the issuing or validating boundary has completed.
- **FR-014**: A service account MUST have a stable ID, workspace, display name, live role, enabled, disabled, or archived state, safe creator attribution, and lifecycle timestamps. Every personal or service credential MUST have a stable ID, principal binding, user-provided label, safe display prefix, non-reversible verifier, creation time, required expiry time, optional last-used and revocation metadata, lifecycle revision, and optional rotation lineage. Names and labels MUST be trimmed, normalized to Unicode NFC, contain 1–80 Unicode characters, and exclude line breaks and control characters. They MAY be duplicated because they are display labels, never identifiers or authorization inputs.
- **FR-015**: Expiry input and output MUST be RFC 3339 UTC timestamps strictly later than the successful issuance time. The secure default and maximum lifetime MUST be 90 days for personal tokens and 365 days for service credentials; owners MAY configure shorter workspace maxima but not longer ones in this feature. Upper bounds are inclusive at the exact instant, and non-expiring credentials MUST be rejected.
- **FR-016**: Immediate rotation MUST require the caller's observed credential revision. Exactly one request against a revision may atomically revoke the predecessor and issue one replacement with the same principal binding and absolute expiry time. Competing or replayed rotations against the old revision MUST return a conflict and no secret. Rotation MUST preserve the stable user or service principal and its audit continuity and MUST NOT extend expiry.
- **FR-017**: A service account MUST also support zero-downtime replacement by allowing an administrator to issue an additional credential, deploy and verify it, and later revoke the predecessor. Each credential remains separately identifiable and revocable while requests remain attributed to the same service principal.
- **FR-018**: Revoked, replaced, expired, malformed, or unknown credentials MUST fail authentication and MUST NOT be recoverable or reactivated. Disabled service accounts suspend credential use until deliberate re-enable; archived service accounts and credentials invalidated by archive MUST never be reactivated.
- **FR-019**: Effective personal-token authority MUST be the lower of its declared ceiling and its owner's live effective role, conditional on the bound access tenure remaining active. Effective service-credential authority MUST be the service account's live role, conditional on the account being enabled and unarchived. A service credential MUST NOT carry an independent role override. Both principal kinds MUST use the existing centralized role-to-permission policy; this feature MUST NOT add custom per-credential scopes or a second permission mapping.
- **FR-020**: API credentials MUST be denied from account, organization, membership, owner-only, workspace-deletion, credential lifecycle, service-account management, authentication-policy, provider-secret, and public-launch-credential management surfaces, even where an administrator browser session could perform the operation. Planning MUST produce and tests MUST enforce a coverage map for every authenticated public route that names its centralized permission, allowed principal kinds, and whether it requires an attributable user session. Routes without an explicit credential decision MUST default to denied.
- **FR-021**: Public launch credentials, workspace API credentials, and agent channel credentials MUST remain separate credential classes. The ordinary workspace bearer path MUST accept only eligible personal or service-account credentials; MCP and REST agent-chat paths MUST accept only the matching per-agent audience.
- **FR-022**: Personal tokens and service-account credentials MUST be rejected by all MCP authentication paths, including merged and standalone exchange. MCP agent chat MUST authenticate an agent-bound MCP credential without a workspace role. OAuth authorization discovery, delegated consent, Ray/Operator MCP, and skill-catalogue exposure remain deferred.
- **FR-023**: On upgrade, the migration MUST transactionally destroy every legacy workspace token's encrypted secret, verifier/hash, and other authenticating material. The former credential MUST not remain an API credential or third credential kind. A mandatory non-secret tombstone MUST record workspace, safe prefix, migration time, final status, and system reason without retaining material capable of reconstructing or validating the secret.
- **FR-024**: Destroying the backend verifier MUST immediately invalidate every legacy API-token-backed MCP session on its next upstream request. Each MCP runtime store managed or configured by the upgraded installation MUST run an idempotent purge of stored legacy credentials and sessions before reporting ready; if a configured store is unavailable, MCP startup/readiness MUST fail closed and retry the purge. Stale external MCP deployments cannot be physically erased by this installation, but their retained copies MUST remain unusable because the backend verifier no longer exists.
- **FR-025**: The destructive migration MUST be idempotent and retry-safe. Interrupted or repeated execution MUST neither restore a credential nor create duplicate principals, credentials, or tombstones. Clients using a destroyed legacy token MUST receive the same non-enumerating response as an unknown credential.
- **FR-026**: The dashboard and release documentation MUST state that the change intentionally has no backward-compatibility window: existing API and MCP integrations stop at upgrade, replacements can be minted only through an interactive session after upgrade, and application downgrade requires restoring a compatible database backup.
- **FR-027**: The Settings UI MUST place personal tokens on the workspace page and service accounts on a dedicated page; service-account detail MUST separate stable identity and role from its credentials. Service-account creation MUST ask for one account name, role, and expiry, while the server creates its first credential with the label `Primary`. The UI MUST include issuance, role and expiry explanations, one-time secret presentation, copy support, expiry warnings, the legacy-removal notice, and confirmations for sensitive lifecycle actions.
- **FR-028**: The dashboard MUST stop automatically fetching, caching, or persisting a recoverable workspace API token. Signed-in dashboard requests MUST use session authentication unless a user explicitly supplies a one-time credential to an external client.
- **FR-029**: Inventory MUST display safe principal and credential metadata: label, kind, prefix, role or role ceiling, owner or service account, status, creator attribution, creation, expiry, per-credential last use, service-account aggregate last use, revocation, and rotation lineage. Lists MUST be paginated with a default page size of 50 and maximum of 100.
- **FR-030**: The system MUST allow at most 10 active personal tokens per user per workspace, 50 non-archived service accounts per workspace, and 5 active credentials per service account. Limit failures MUST return before secret generation and leave no partial record. These limits MAY be made stricter by workspace policy but not looser in this feature.
- **FR-031**: Successful credential use MUST update per-credential and aggregate principal last-used metadata within five minutes without making authorization depend on that update succeeding. The dashboard and operational event stream MUST warn at 30, 7, and 1 day before an active credential expires.
- **FR-032**: The system MUST audit service-account and credential creation, relabel, role change, rotation, issue, revoke, disable, enable, archive, legacy migration, and automatic invalidation with the session actor or system cause, workspace, stable principal ID and kind, credential ID where applicable, safe reason, timestamp, outcome, and correlation data. Every otherwise-audited API action made with a credential MUST include the stable user or service principal and specific credential ID.
- **FR-033**: Clients MUST receive the same non-enumerating invalid-credential response for malformed, unknown, expired, revoked, disabled, archived, or ended-tenure credentials. Internally, authentication MAY emit a counter and structured diagnostic event with a bounded reason; authorization denials MUST be recorded separately. Metrics labels MUST use only bounded principal-kind, outcome, and reason values and MUST exclude names, IDs, prefixes, and secrets.
- **FR-034**: Signed-in dashboard consumers MUST be able to perform permitted lifecycle operations through the session-authenticated REST contract. The generated TypeScript SDK snapshot MUST remain synchronized, but the published bearer-authenticated SDK MUST NOT advertise lifecycle methods as usable until it has a separately specified session-authentication mode. The SDK MUST continue to support using personal and service-account credentials for eligible APIs.
- **FR-035**: Product documentation MUST explain users versus service accounts, personal tokens versus service credentials, workspace roles and ceilings, mandatory expiry, one-time display, overlapping and immediate replacement, the breaking legacy-token removal, correct secret storage, and the role-free per-agent MCP and REST chat credential model. It MUST state that personal and service credentials are not accepted by MCP and that channel credentials are not accepted by workspace APIs.
- **FR-036**: Backend unit, integration, and contract coverage MUST demonstrate personal tenure and role enforcement; service-account role, disable, re-enable, archive, creator independence, shared-principal attribution, and credential isolation; one-time display and hash-only persistence; expiry boundaries and warnings; rotation races and lost responses; quotas and pagination; cross-workspace denial; credential-class separation; and session-only lifecycle behavior with no bearer fallback.
- **FR-037**: MCP tests MUST demonstrate rejection of personal, service-account, REST-agent, public-launch, expired, rotated, revoked, cross-agent, and malformed credentials; acceptance of only the bound MCP audience; a chat-only tool catalogue with no direct retrieval resources; next-request invalidation of every legacy API-token-backed session; idempotent controlled-store purge; fail-closed readiness/retry; and harmless rejection of stale external credentials.
- **FR-038**: Migration tests MUST demonstrate immediate backend authenticating-material destruction, mandatory tombstones, idempotent retry, failure recovery, coordination with controlled MCP-store purges, and non-enumerating legacy-token rejection without a compatibility window.
- **FR-039**: Playwright coverage MUST demonstrate personal-token creation; dedicated service-account navigation; service-account creation with an automatically named `Primary` credential; role change, disable/re-enable, archive, and multi-credential management; one-time copy/acknowledgement; expiry warnings; safe paginated inventory; a unified MCP card with embedded credential management; REST agent-credential management; permission denials; and the absence of automatic browser storage for credential secrets.
- **FR-040**: The agent access-grant aggregate MUST support two distinct channel audiences: MCP agent chat and REST agent chat. Both MUST use the `agent-api` principal kind, `agent` role vocabulary, one agent/workspace binding, mandatory expiry, safe metadata, hash-only verification, one-time reveal, rotation, revocation, last-use, and lifecycle audit conventions.
- **FR-041**: MCP and REST agent credentials MUST be independently generated opaque secrets. An authenticator MUST resolve a credential only when its persisted audience equals the expected transport; callers MUST NOT infer audience from token text.
- **FR-042**: `POST /api/v1/agents/{agentId}/chat` MUST authenticate a REST-agent credential directly, verify the path agent matches its immutable binding, and call the normal chat turn loop with that bound workspace and agent. The route MUST NOT accept a workspace session, personal token, service credential, MCP credential, public-launch credential, or a caller-supplied replacement agent ID.
- **FR-043**: The REST agent-chat request MUST support starting or resuming a conversation and non-streaming or streaming responses using the existing assistant chat contract wherever applicable. A resumed conversation bound to another agent or workspace MUST be rejected.
- **FR-044**: An MCP agent credential MAY be exchanged for a short-lived session, but every validation MUST re-check the underlying grant ID, version, audience, agent/workspace binding, enabled state, expiry, rotation, and revocation before running chat.
- **FR-045**: The MCP agent credential surface MUST expose only the stateful agent chat tool. Direct grounded-answer tools, document-resource listing/reading, workspace retrieval APIs, generic document tools, write tools, Ray tools, operator tools, and skill-catalogue management MUST NOT be registered for this audience.
- **FR-046**: Agent channel credential lifecycle routes MUST require an interactive session and the centralized agent-management permission. Members without that permission and all bearer-only callers MUST be denied. The acting user's role MUST authorize issuance but MUST NOT be persisted as credential authority.
- **FR-047**: The agent Channels UI MUST present MCP endpoint/setup and MCP credential management in one card, use the user-facing term `MCP credential`, explain that it connects an AI client to this agent, and avoid internal `converse`, direct-document-search, member, or administrator terminology for the credential.
- **FR-048**: The agent API card MUST describe per-agent chat only, show the explicit path containing the selected agent ID, manage REST agent credentials in that card, and MUST NOT instruct users to upload documents, author routines, or paste a personal/service credential into the agent channel.
- **FR-049**: Agent channel lifecycle and use MUST emit bounded audit/operational events with audience, outcome, and safe reason plus stable grant/workspace/agent identifiers where audit permits. Logs, metrics, traces, analytics, and API responses after issuance MUST not contain raw secrets, authorization headers, prompts, completions, documents, or retrieved chunks.

### Settled Authorization Matrices

Role ordering is `member < admin`; `owner` exists only for signed-in users and is capped to `admin` when selecting a personal-token ceiling or service-account role. `AccountAccessService` resolves account membership and workspace grants before these tables apply.

| Signed-in user's effective workspace role | Personal ceilings selectable | Service-account lifecycle | Service-account roles assignable |
|---|---|---|---|
| No access | None | Denied | None |
| Member | Member | Denied | None |
| Administrator | Member, administrator | Allowed | Member, administrator |
| Owner | Member, administrator | Allowed | Member, administrator |

| Personal token's declared ceiling | Owner's current effective role | Result on next request |
|---|---|---|
| Member | Member, administrator, or owner | Member |
| Administrator | Member | Member |
| Administrator | Administrator or owner | Administrator |
| Member or administrator | No current access, ended tenure, deleted user, or deleted workspace | Token invalid |

| Service-account state | Current service-account role | Result for every bound credential on next request |
|---|---|---|
| Enabled | Member | Member |
| Enabled | Administrator | Administrator |
| Disabled | Member or administrator | Credential suspended |
| Archived or workspace deleted | Member or administrator | Credential permanently invalid |

| Lifecycle operation | Owner with member/admin/owner session | Other administrator/owner session | Ordinary member session | Bearer-only request |
|---|---|---|---|---|
| Create personal token for self | Allowed within ceiling table | Not allowed on another user's behalf | Allowed for self at member ceiling | Denied |
| List own personal tokens | Allowed | Allowed only when they are also the owner | Allowed | Denied |
| Relabel/rotate/revoke own personal token | Allowed | Allowed only when they are also the owner | Allowed | Denied |
| List all personal-token metadata | No, unless administrator/owner | Allowed | Denied | Denied |
| Revoke another user's personal token | No, unless administrator/owner | Allowed | Denied | Denied |
| Reveal or relabel/rotate another user's personal token | Denied | Denied | Denied | Denied |
| Create/list/change/disable/enable/archive service accounts | Allowed only when administrator/owner | Allowed | Denied | Denied |
| Issue/list/relabel/rotate/revoke service credentials | Allowed only when administrator/owner | Allowed | Denied | Denied |
| Issue/list/rotate/revoke MCP or REST agent credentials | Allowed only with agent-management permission | Allowed with agent-management permission | Denied unless separately granted agent-management permission | Denied |

| Presented agent credential | MCP agent-chat surface | REST bound-agent chat surface | Ordinary workspace API | Another agent |
|---|---|---|---|---|
| MCP audience for bound agent | Allowed | Denied | Denied | Denied |
| REST audience for bound agent | Denied | Allowed | Denied | Denied |
| Personal or service credential | Denied | Denied | Evaluated by ordinary route policy | Denied as an agent credential |
| Public launch credential | Denied | Denied | Denied | Denied |

For ordinary bearer-capable application routes, a valid user session takes precedence when both a cookie and bearer header are present; if no valid session is present, the bearer credential is evaluated. Principal and credential lifecycle routes authenticate exclusively from the interactive session and never fall back to bearer authentication. Whether a redundant bearer header accompanying a valid session is ignored or rejected is an implementation decision for the technical plan, not an authorization grant.

### Key Entities *(include if feature involves data)*

- **Personal API Credential**: A workspace-bound bearer credential of an existing user, with a declared role ceiling, continuous-access-tenure binding, label, expiry, non-reversible verifier, and lifecycle metadata. It is not a separate user or service identity.
- **Continuous Workspace Access Tenure**: An immutable identity for one uninterrupted active account-membership period through which a user can access a workspace. Workspace grants may change the user's role within that period but do not independently create or end the tenure. Membership removal, user deletion, or workspace deletion ends it; re-invitation creates a new tenure.
- **Workspace Service Account / Service Principal**: A stable, named, workspace-owned non-human identity with a live member or administrator role and enabled, disabled, or archived state. It can own multiple credentials and survives creator departure.
- **Service Account Credential**: One replaceable bearer secret bound to a service account, with its own stable ID, label, safe prefix, non-reversible verifier, expiry, last use, revocation, and rotation lineage. It carries no independent role.
- **Authenticated API Principal**: The request identity produced after a valid credential is resolved. It carries principal kind, user or service-principal ID, credential ID, workspace, and effective role for centralized authorization and audit.
- **Agent Channel Credential**: A role-free opaque bearer secret bound to one workspace, one agent, and one transport audience (`mcp` or `rest`). It can enter only that agent's chat turn loop and carries safe lifecycle metadata but no workspace permissions.
- **Agent Chat Principal**: The narrow runtime identity produced from a valid agent channel credential or derived short-lived session. It contains the immutable workspace, agent, audience, credential/version, and conversation binding needed by chat; it is not an account-access principal.
- **Principal and Credential Lifecycle Event**: Safe, append-only evidence that a service account or credential was created, changed, rotated, revoked, disabled, enabled, archived, expired, migrated, or denied, linked by identifiers and correlation data without secret material.
- **Legacy Credential Tombstone**: Mandatory non-secret evidence that a former shared workspace credential was irreversibly destroyed, retaining only safe identification and migration status.

## Assumptions and Dependencies

- The existing owner, administrator, and member workspace role model remains the source of authority. Personal token ceilings and service-account roles use only member and administrator.
- A personal ceiling or service-account role is intentionally the only credential-level authorization choice in this phase. Fine-grained custom scopes require a separate policy decision and specification because they would create a second permission model.
- Service-account names and credential labels may be duplicated. Stable IDs and safe prefixes, not display text, distinguish records.
- Immediate rotation is for suspected exposure or one-step replacement. Multiple credentials beneath one service account provide the zero-downtime create, deploy, verify, and revoke workflow.
- Authentication remains opaque bearer-token authentication. Operator-minted agent channel credentials do not require OAuth; delegated third-party installation and consent flows remain a later MCP/OAuth specification.
- Issue #352's multiple-token lifecycle, labels, member/admin roles, one-time display, audit, UI, and documentation scope is superseded by this specification and SHOULD be updated to reference it after stakeholder approval.
- Spec 062's treatment of a legacy token as an administrator principal is intentionally superseded by the destructive migration in FR-023; its explicit principal and mixed-auth rules remain the baseline where this specification does not override them.
- Spec 081's requirement that the single administrator workspace token remain the sole workspace-level credential is intentionally superseded for workspace API tokens. Its rule that agent-bound access grants are not workspace API tokens remains in force.
- This specification supersedes Spec 098 where that spec models MCP agent credentials as `public-launch` grants or exposes direct retrieval/resources. Spec 098 remains authoritative for the existing short-lived session and stateful chat mechanics not changed here.
- Issue #1053's permanent exclusion of identity, access, credential, and secret operations from Ray remains in force. If implementation touches operator capability coverage, it MUST record this feature as excluded rather than add Ray token-management tools.
- Backward compatibility for the legacy workspace token and its MCP sessions is explicitly not required. Upgrade immediately destroys the legacy credential; operators reissue personal or service-account credentials afterward.
- Destroying legacy encrypted secrets makes the database migration forward-only. Application-code rollback requires restoring a compatible pre-migration database backup and reissuing any subsequently created credentials; release notes MUST state this before migration runs.

## Out of Scope

- OAuth authorization-server or resource-server behavior, delegated consent, refresh tokens, dynamic client registration, or MCP authorization discovery.
- Ray/Operator MCP access to identity, membership, API-token, secret, credential, or skill-catalogue management.
- Acceptance or exchange of personal or service-account credentials on MCP; per-tool grants; runtime agent selection; or exposure of the workspace skill catalogue to an external agent.
- Direct retrieval credentials or capabilities, raw document resources over an agent chat credential, and changes to public launch credentials.
- Fine-grained per-token custom scopes, arbitrary permission selection, owner tokens, account-wide tokens, or tokens spanning multiple workspaces.
- Automatically minting a personal token for every user or allowing an administrator to create a personal secret on another user's behalf.
- Preserving legacy API-token or API-token-backed MCP compatibility during upgrade.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In upgrade tests, 100% of legacy shared workspace tokens and API-token-backed MCP sessions are rejected on their next backend request, all backend authenticating material is destroyed, and no endpoint or MCP runtime store controlled by the upgraded installation can return the former secret after readiness succeeds.
- **SC-002**: In authorization tests, 100% of personal-token requests are limited by both the declared ceiling and the owner's live workspace role, and access removal invalidates the token on the next request.
- **SC-003**: In authorization tests, two credentials beneath one service account authenticate as the same stable principal; credential-level revocation affects only its target; and role change, disable, re-enable, and archive affect every bound credential on the next request.
- **SC-004**: Across issuance and rotation security tests, a credential secret appears in exactly one successful response and is absent from every later API response and every Radioso-owned persistent or observability surface covered by request logging, error serialization, audit, analytics, frontend storage, and support diagnostics. Transient in-memory comparison at the authentication boundary is permitted only when it is neither persisted nor observed.
- **SC-005**: In Playwright tests, a signed-in user can create a personal token, and an owner or administrator can create a service account and issue its first credential, through one creation flow and one one-time-secret acknowledgement screen without asking another user for a credential.
- **SC-006**: The authenticated-route coverage map has an explicit personal-token, service-account-credential, or session-only decision for 100% of public authenticated routes, and representative member and administrator tests produce the documented allow/deny result without relying on accidental session fallback.
- **SC-007**: MCP contract tests accept only a valid MCP-audience credential for its bound agent, expose only the stateful chat tool, reject all workspace/API/cross-audience/cross-agent/expired/rotated/revoked credentials, and preserve legacy purge behavior; no Ray, skill catalogue, OAuth, or direct retrieval capability is exposed.
- **SC-008**: Contract and browser tests cover every supported service-account and credential lifecycle action and credential-class boundary, including cross-workspace, expired, revoked, disabled, archived, malformed, quota, pagination, and concurrent-rotation cases.
- **SC-009**: Audit contract tests verify that every successful lifecycle change and representative credential-authenticated API action is attributable by session actor or stable API principal, workspace, principal and credential IDs, role, outcome, and correlation data, and that the allowed audit schema contains no authorization header, secret, verifier, ciphertext, or unrestricted metadata field.
- **SC-010**: The REST contract, generated TypeScript SDK snapshot, dashboard, quick-start/API documentation, and MCP documentation all describe the same workspace-credential and role-free agent-channel model, expiry, immediate migration behavior, and session-only minting boundary; bearer-SDK documentation does not claim session-only lifecycle support.
- **SC-011**: Live local verification creates MCP and REST credentials through the running frontend, completes a real chat turn through each transport, proves cross-audience and ordinary-workspace denial, and proves the prior secret fails after rotation or revocation.
