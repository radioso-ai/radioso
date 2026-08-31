# Research: Personal API Tokens and Workspace Service Accounts

## Decision 1: Separate principals from credentials

**Decision**: Existing users remain the principal behind personal API credentials. A new workspace service account is the stable non-human principal behind one or more service credentials.

**Rationale**: Role changes, disable/archive behavior, creator departure, audit history, and multiple deployment credentials apply to the stable identity rather than to an individual secret.

**Alternatives considered**:

- Treat each service token as a principal: rejected because rotation and multi-deployment use fragment identity and audit history.
- Model service accounts as users: rejected because they must not have email, login, account membership, or owner authority.

## Decision 2: Create a focused machine-access module

**Decision**: Add `backend/src/modules/machineAccess/` for service-account state, personal/service credential lifecycle, authentication, access-tenure resolution, expiry warnings, safe audit payloads, and public ports.

**Rationale**: `AuthService` currently mixes legacy workspace-token issuance with authentication. Adding the full lifecycle there would create a larger orchestration service and violate the approved boundary. `AccountAccessService` remains the single role-to-permission authority.

**Alternatives considered**:

- Extend `AuthService`: rejected because lifecycle, inventory, quotas, migration, and service-account state are not generic session-auth concerns.
- Reuse agent access grants: rejected because those grants are agent-bound and have different roles and credential semantics.

## Decision 3: Use one credential aggregate with exclusive principal bindings

**Decision**: Persist all new API credentials in one `api_credentials` aggregate with common verifier/lifecycle fields and a database-enforced exclusive binding to either a personal user/access tenure or a service account.

**Rationale**: Secret generation, hashing, one-time display, expiry, revision, rotation, revocation, last-use tracking, pagination, and quota behavior must be identical across credential kinds.

**Alternatives considered**:

- Separate personal and service credential tables: rejected because it duplicates security-critical lifecycle logic.
- Extend `workspace_tokens`: rejected because its one-row-per-workspace, recoverable-secret design encodes the behavior being removed.

## Decision 4: Bind personal credentials to account-membership tenure

**Decision**: Bind a personal credential to the active `account_memberships.id` observed at issuance, plus the user and workspace. Authenticate only while that exact membership row remains active; resolve workspace grants live for every request.

**Rationale**: A removed and re-invited user receives a new membership ID, so an old credential cannot silently revive. Workspace-grant changes within one membership tenure adjust effective role without replacing the tenure.

**Alternatives considered**:

- Bind only to user ID: rejected because re-invitation would revive an old credential.
- Create a second tenure system: rejected because membership IDs already provide the required continuous-access identity.

## Decision 5: Resolve effective role at authentication time

**Decision**: The credential authenticator resolves a personal credential as the lower of its declared ceiling and the user's current effective workspace role. A service credential derives the current role and state from its service account. It returns a typed principal to existing centralized permission enforcement.

**Rationale**: Permissions must change on the next request after role, membership, grant, or service-account state changes, without storing a second permission map.

**Alternatives considered**:

- Snapshot permissions into each credential: rejected because permissions would drift.
- Add custom `scopes[]`: rejected by the approved specification.

## Decision 6: Store only a verifier and safe prefix

**Decision**: Generate versioned, high-entropy opaque personal and service secrets, return plaintext once, and persist only a SHA-256 verifier plus a short safe display prefix. Never encrypt new credential plaintext.

**Rationale**: High-entropy tokens can be looked up safely by a deterministic verifier; omitting ciphertext makes later reveal impossible by construction.

**Alternatives considered**:

- Encrypt token plaintext for recovery: rejected because one-time display is a security invariant.
- Use low-entropy user-chosen secrets with a password hash: rejected because API credentials should be generated, opaque bearer values.

## Decision 7: Use conditional, immediate rotation plus parallel credentials

**Decision**: Immediate rotation is an optimistic-revision operation that atomically revokes one credential and issues one successor with the same principal and absolute expiry. Zero-downtime replacement uses a second concurrently active service credential followed by explicit predecessor revocation.

**Rationale**: The two workflows address different risks: compromise response requires immediate invalidation, while routine deployment requires overlap. A stable service account preserves attribution in both.

**Alternatives considered**:

- Grace periods inside rotation: rejected because they blur compromise response and complicate concurrency.
- Unconditional rotation: rejected because racing requests could return multiple secrets and invalidate each other.

## Decision 8: Make lifecycle APIs interactive-session-only

**Decision**: Personal-token, service-account, and service-credential lifecycle routes use dashboard session authentication with CSRF protection and no bearer fallback. Ordinary workspace routes preserve existing valid-session-first, bearer-second behavior.

**Rationale**: A bearer credential must never mint or manage other principals or credentials. Existing dashboard-only middleware provides the correct boundary.

**Alternatives considered**:

- Allow administrator service credentials to manage tokens: rejected because compromise would enable credential proliferation.
- Add cookie/session support to the public SDK: rejected as separate SDK scope; the dashboard REST client owns lifecycle use.

## Decision 9: Make credential eligibility explicit for authenticated routes

**Decision**: Add an HTTP-owned, default-deny coverage policy that records each authenticated operation's centralized permission, accepted principal kinds, and session-only status. Contract tests require complete coverage for registered authenticated operations.

**Rationale**: Implicit bearer fallback across a large route set risks exposing account, membership, provider-secret, Ray, public-launch, or lifecycle operations.

**Alternatives considered**:

- Rely only on current permission strings: rejected because some administrator permissions are intentionally session-only for machine principals.
- Maintain policy in the machine-access domain: rejected because route eligibility is a transport/public-contract concern.

## Decision 10: Use a hard, forward-only legacy migration

**Decision**: Migration `157` creates the new tables and a mandatory tombstone, copies only safe legacy metadata, and drops the legacy `workspace_tokens` table in the same transaction. Legacy reveal/rotate/issue code is removed in the same release.

**Rationale**: Backward compatibility is explicitly unnecessary, and retained ciphertext or verifiers would preserve the privilege-escalation risk.

**Alternatives considered**:

- Preserve legacy tokens temporarily: rejected by the approved product decision.
- Mark legacy rows revoked but keep ciphertext/hash: rejected because recoverable/authenticating material would remain.

## Decision 11: Treat MCP purge as runtime readiness, not database migration

**Decision**: New personal and service credentials are rejected by merged, standalone/exchange, stdio preflight, and agent-converse MCP paths. Destroying the backend verifier invalidates legacy sessions. MCP runtime stores controlled by the upgraded installation add an idempotent purge lifecycle that completes before readiness; unavailable configured storage fails closed and retries.

**Rationale**: The backend migration cannot physically erase Redis belonging to another process. Controlled runtime stores can and must purge their encrypted legacy copies, while stale external copies become unusable when upstream validation fails.

**Alternatives considered**:

- Let new API credentials continue authenticating MCP: rejected because MCP authorization is deliberately deferred.
- Delete only backend token rows: rejected because controlled Redis stores would retain recoverable plaintext copies.
- Fall back to in-memory storage when Redis is unavailable: rejected because it would report readiness before the required purge.

## Decision 12: Keep last-use and expiry signals outside authorization success

**Decision**: Authentication schedules a best-effort credential-use update, throttled so one credential writes at most once per five minutes. A composition-owned daily scanner emits deduplicated 30/7/1-day warning events and the inventory response derives current warning state.

**Rationale**: Metadata failure must not grant or deny an otherwise valid request. A lightweight lifecycle hook meets warnings without introducing document-worker or AMQP contracts.

**Alternatives considered**:

- Synchronous last-use writes on every request: rejected for latency and write amplification.
- Add an AMQP worker job: rejected because no durable cross-service payload is needed and it would couple machine access to document processing.
- Warn only when the settings page is opened: rejected because operators need an operational signal without visiting the page.

## Decision 13: Bound inventory and creation atomically

**Decision**: Enforce 10 active personal credentials per user/workspace, 50 non-archived service accounts per workspace, and 5 active credentials per service account inside transactionally locked repository operations. Inventory uses stable descending creation ordering with `page`/`limit`, default 50 and maximum 100.

**Rationale**: Limits must be race-safe and secret generation must not occur before capacity is reserved. Page/limit matches the dashboard's existing pagination primitive.

**Alternatives considered**:

- Service-only count checks: rejected because concurrent creates can exceed limits.
- Cursor pagination: valid, but rejected for this feature because existing dashboard pagination already uses page/limit and maximum inventories are small.

## Decision 14: Keep audit metadata typed and bounded

**Decision**: Machine access owns typed audit-event builders. Lifecycle events include the session actor or system cause, workspace, stable principal ID/kind, credential ID when applicable, role, bounded reason/outcome, and correlation ID. Existing audited API actions add principal and credential attribution. Metrics use bounded labels only.

**Rationale**: The generic audit service accepts arbitrary metadata, so callers need a safe allowlist that cannot accidentally include plaintext, verifier, authorization headers, or user labels.

**Alternatives considered**:

- Pass service inputs directly as audit metadata: rejected because secrets and high-cardinality values could leak.

## Decision 15: Migrate the dashboard to session-authenticated APIs

**Decision**: Remove workspace-token fetch/cache/local-storage behavior from the frontend. All signed-in dashboard adapters use cookies plus `X-Workspace-Id`; external snippets use placeholders and link to the API-access UI. One-time secrets exist only in transient component state.

**Rationale**: Most dashboard adapters currently depend on the shared bearer token. Deleting the legacy secret without this migration would break the dashboard and continuing to cache new credentials would violate one-time display.

**Alternatives considered**:

- Change only the settings card: rejected because the rest of the dashboard would continue requesting a deleted token.
- Automatically mint/cache a personal token: rejected by the product model and one-time-secret invariant.

## Decision 16: Keep public contract generation and queues aligned

**Decision**: Register lifecycle contracts in the backend code-first OpenAPI registry, regenerate backend artifacts, synchronize the TypeScript SDK and MCP OpenAPI snapshots, but do not add bearer-SDK lifecycle helpers. Record document-worker and AMQP payloads, retry behavior, queue tests, and queue docs as unaffected.

**Rationale**: Authentication terminates at HTTP/MCP request entry and no credential enters document-processing jobs. The repository constitution requires generated contract and queue-impact parity.

**Alternatives considered**:

- Hand-edit generated OpenAPI files: prohibited by the constitution.
- Add session authentication to the SDK: rejected as separate product/API-client scope.

## Decision 17: Ray remains explicitly excluded

**Decision**: API-access and service-account operations receive a permanent Operator Copilot coverage-map exclusion; no Ray descriptor is added.

**Rationale**: Identity, access, and secret management are on Ray's permanent never-list. Exclusion is required by the repository's operator-facing coverage rule.

**Alternatives considered**:

- Add read-only inventory to Ray: rejected because even credential metadata is part of identity/access management and would establish the wrong trust boundary.
