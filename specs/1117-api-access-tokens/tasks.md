# Tasks: Personal API Tokens and Workspace Service Accounts

**Input**: Approved design artifacts in `specs/1117-api-access-tokens/`
**Tests**: Backend tasks are ordered test-first. Visible frontend journeys use Playwright; adapter/state logic may use unit tests.
**Organization**: Tasks are grouped by prerequisite and user story. `[P]` means the task can run in parallel because it owns disjoint files and has no incomplete dependency.

## Phase 1: Foundation and explicit boundaries

- [ ] T001 Capture the authenticated-route eligibility coverage map and permanent Ray exclusions in `backend/src/app/http/apiPrincipalRoutePolicy.ts` tests and `backend/src/modules/operatorCopilot/` coverage tests before adding production policy.
- [ ] T002 [P] Add failing credential value-object tests for NFC labels, control characters, prefixes, required expiries, secure maxima, and token parsing in `backend/tests/unit/machineAccess/credential-values.test.ts`.
- [ ] T003 [P] Add failing service-principal transition and effective-role tests in `backend/tests/unit/machineAccess/service-account.test.ts`.
- [ ] T004 [P] Add failing personal tenure/effective-role tests in `backend/tests/unit/machineAccess/personal-principal.test.ts`.
- [ ] T005 Add migration/repository integration tests covering new tables, constraints, hash-only rows, quotas, conditional rotation, stable pagination, and idempotent legacy tombstones in `backend/tests/integration/machine-access-repository.integration.test.ts` and `backend/tests/integration/machine-access-migration.integration.test.ts`.
- [ ] T006 Add migration `backend/src/db/migrations/158_machine_access.sql` with `workspace_service_accounts`, `api_credentials`, and `legacy_workspace_credential_tombstones`, then irreversibly tombstone/destroy legacy workspace-token authenticating material.
- [ ] T007 Update Kysely database types/schema snapshots for migration 158 in the existing `backend/src/db/` generated/type ownership files.
- [ ] T008 Implement machine-access domain values/entities/errors and narrow repository/tenure/role/clock/secret/audit/last-use ports in `backend/src/modules/machineAccess/` until T002–T004 pass.
- [ ] T009 Implement versioned opaque token generation, safe-prefix extraction, and non-reversible verifier matching in `backend/src/modules/machineAccess/credentialSecretCodec.ts`.
- [ ] T010 Implement transactional Kysely adapters in focused files under `backend/src/db/repositories/machineAccess/` until T005 passes.
- [ ] T011 Wire machine-access repositories, codec, clock, role/tenure resolver, audit sink, and last-use recorder in `backend/src/app/composition/` without putting domain rules in composition.
- [ ] T012 Add bounded machine-access audit/metric/diagnostic payload tests and implementations that exclude raw headers, secrets, verifier values, labels, and high-cardinality metric attributes.

## Phase 2: User Story 1 — Mint a personal API token (P1)

**Goal**: A signed-in user can issue and manage their own live-role-bounded personal credentials, with administrators able only to audit safe metadata and revoke others.

- [ ] T013 [US1] Add failing application-service tests for personal issuance, 10-active quota, ceiling selection, one-time secret response, hash-only persistence, owner-only mutation, admin safe audit/revoke, and cross-workspace denial in `backend/tests/unit/machineAccess/personal-credential-service.test.ts`.
- [ ] T014 [US1] Add failing authentication tests for live role demotion, promotion ceiling, tenure end/reinvite, deletion, expiry boundaries, malformed/unknown/revoked uniform failures, and last-use success-only updates in `backend/tests/unit/machineAccess/api-principal-authenticator.test.ts`.
- [ ] T015 [US1] Implement `PersonalCredentialService` and `ApiPrincipalAuthenticator` in `backend/src/modules/machineAccess/services/` until T013–T014 pass.
- [ ] T016 [US1] Add failing Supertest coverage for session-only personal lifecycle routes, cookie precedence, CSRF, pagination, conflict mapping, one-time response, and bearer-fallback denial in `backend/tests/integration/api-access-personal.integration.test.ts`.
- [ ] T017 [US1] Implement dedicated schemas/presenters/routes in `backend/src/app/http/schemas/apiAccessSchemas.ts`, `presenters/apiAccessPresenter.ts`, and `routes/apiAccessRoutes.ts` as transport-only adapters.
- [ ] T018 [US1] Delegate ordinary bearer authentication from `backend/src/modules/auth/services/authService.ts` and `backend/src/app/http/middleware/requireApiToken.ts` to the principal authenticator without adding lifecycle logic there.
- [ ] T019 [US1] Implement the explicit default-deny principal-kind route policy in `backend/src/app/http/apiPrincipalRoutePolicy.ts`, declare the initial eligible ordinary routes, and make T001 pass.
- [ ] T020 [US1] Register personal-token paths and schemas in focused code-first files under `backend/src/app/http/openapi/paths/` and `backend/src/app/http/openapi/schemas/`.

## Phase 3: User Story 2 — Create a workspace service account (P1)

**Goal**: Administrators manage durable service identities whose independently replaceable credentials share live principal authority and audit identity.

- [ ] T021 [US2] Add failing service-account application tests for create-with-first-credential atomicity, 50-account quota, live role, creator independence, and enable/disable/archive transitions in `backend/tests/unit/machineAccess/service-account-service.test.ts`.
- [ ] T022 [US2] Add failing service-credential tests for five-active quota, sibling isolation, multi-credential shared principal, expiry, relabel, revoke, lost response recovery, zero-downtime overlap, and conditional immediate rotation races in `backend/tests/unit/machineAccess/service-credential-service.test.ts`.
- [ ] T023 [US2] Implement focused `ServiceAccountService` and `ServiceCredentialService` orchestration under `backend/src/modules/machineAccess/services/` until T021–T022 pass.
- [ ] T024 [US2] Extend principal-authenticator tests for enabled/disabled/archived service principals, live role changes, deleted workspace, credential isolation, and stable principal/specific credential attribution.
- [ ] T025 [US2] Implement service-principal authentication and best-effort aggregate/per-credential last-use recording without coupling request authorization to metadata success.
- [ ] T026 [US2] Add failing Supertest coverage for admin-only service-account and credential lifecycle endpoints, revisions, pagination, quotas, role ceiling, cross-workspace denial, and bearer-fallback denial in `backend/tests/integration/api-access-service-accounts.integration.test.ts`.
- [ ] T027 [US2] Extend dedicated API-access schemas/presenters/routes with service-account and credential endpoints until T026 passes.
- [ ] T028 [US2] Register service-account and service-credential paths/schemas in the code-first OpenAPI registry.

## Phase 4: User Story 3 — Enforce live role-bounded access (P1)

**Goal**: Browser, personal, and service principals use centralized permissions while sensitive routes remain attributable-session-only.

- [ ] T029 [US3] Add contract tests that enumerate every authenticated public route with permission, allowed principal kinds, and session-only status in `backend/tests/contract/api-principal-route-policy.contract.test.ts`.
- [ ] T030 [US3] Add end-to-end authorization matrix tests for session/personal/service/public-launch/agent-converse credentials in `backend/tests/contract/token-authorization.contract.test.ts`.
- [ ] T031 [US3] Add the three session capabilities to `backend/src/modules/account/services/accountAccessService.ts` and its focused unit tests while keeping role mapping as its only new responsibility.
- [ ] T032 [US3] Apply the central principal-kind route policy at HTTP composition/registration so undeclared routes deny machine credentials and lifecycle/account/organization/membership/provider-secret/public-launch surfaces remain session-only.
- [ ] T033 [US3] Include stable principal kind/ID and credential ID in existing audit context for otherwise-audited eligible API requests, with safe authorization-denial observability.
- [ ] T034 [US3] Add/update authenticated rate-limit tests and keying so personal credentials and service credentials cannot collapse into the removed shared workspace-token bucket.

## Phase 5: User Story 4 — Replace the shared administrator token safely (P1)

**Goal**: Upgrade irreversibly removes legacy authentication and purges controlled MCP session stores before readiness.

- [ ] T035 [US4] Add backend migration failure/retry and non-enumerating legacy-rejection cases to `backend/tests/integration/machine-access-migration.integration.test.ts` and remove obsolete success expectations from legacy workspace-token tests.
- [ ] T036 [P] [US4] Add failing MCP package tests for personal/service rejection, idempotent in-memory and Redis legacy-session purge, unavailable-store fail-closed readiness/retry, and stale external credential rejection in `packages/radioso-mcp-server/tests/`.
- [ ] T037 [P] [US4] Add failing merged MCP and context-exchange integration tests for new credential rejection and next-request legacy invalidation in `backend/tests/integration/mcp-merged-mode.integration.test.ts` and `backend/tests/contract/workspace-mcp-context.contract.test.ts`.
- [ ] T038 [US4] Extend the MCP session-store contract and in-memory/Redis implementations under `packages/radioso-mcp-server/src/` with idempotent namespace-safe legacy purge and readiness state until T036 passes.
- [ ] T039 [US4] Add standalone HTTP startup/readiness retry coordination and stdio credential-eligibility preflight under `packages/radioso-mcp-server/src/`, never persisting the presented API credential as a usable MCP session.
- [ ] T040 [US4] Add merged-mode purge/readiness integration at `backend/src/app/server/mcpMount.ts` and composition, keeping MCP transport free of credential lifecycle rules.
- [ ] T041 [US4] Make `/api/v1/workspace/mcp/context` reject personal/service principals after resolution and remove lexical token-shape classification from agent-converse authentication.
- [ ] T042 [US4] Retire legacy workspace-token repository/composition/routes only after all callers migrate; retain unrelated uses of `WORKSPACE_TOKEN_SECRET` such as access grants when still required.

## Phase 6: User Story 5 — Manage lifecycle, inventory, and warnings (P2)

**Goal**: Safe inventories, expiry warnings, audits, and lifecycle races are operationally trustworthy.

- [ ] T043 [US5] Add tests for stable page ordering/default/max bounds, safe owner/creator/lineage metadata, aggregate last use, expiry warning thresholds, idempotent revocation, and archived-history retention.
- [ ] T044 [US5] Implement a composition-owned daily expiry-warning lifecycle with an injected clock/event sink and idempotent 30/7/1-day event behavior; do not add AMQP payloads.
- [ ] T045 [US5] Implement a coalesced asynchronous last-use writer that meets the five-minute bound and records only successful credential authentication.
- [ ] T046 [US5] Complete lifecycle audit events and automatic invalidation/tombstone audit attribution with bounded reason and request correlation fields.
- [ ] T047 [US5] Add API-access summary endpoint tests/implementation for effective role, capabilities, lifetime defaults/maxima, limits, legacy migration status, and `mcpCredentialSupport: "unsupported"`.

## Phase 7: User Story 6 — Configure API access clearly (P2)

**Goal**: Dashboard users create and manage the correct credential type without browser persistence or confusing it with public/agent-converse credentials.

- [ ] T048 [P] [US6] Add failing frontend unit tests for the session-only API-access adapter, safe response mapping, one-time-secret transient state, and removal of automatic bearer retry/storage in `frontend/tests/unit/api-access-api.test.ts` and `frontend/tests/unit/workspace-api-auth.test.ts`.
- [ ] T049 [P] [US6] Add failing Playwright journeys for personal creation/lifecycle, service-account lifecycle/multiple credentials, roles/permissions, one-time acknowledgement/copy, pagination, warnings, migration notice, and storage absence in `frontend/tests/e2e/api-access-settings.spec.ts`.
- [ ] T050 [US6] Implement `frontend/lib/api-api-access.ts` using session cookies, CSRF, and `X-Workspace-Id`; expose typed personal/service lifecycle operations without accepting or retaining a bearer secret.
- [ ] T051 [US6] Remove automatic workspace-token fetch, bearer fallback, and `radioso.workspaceTokens` persistence from `frontend/lib/api-client.ts`, `frontend/lib/api-storage.ts`, auth/workspace contexts, direct chat/routine/connector fetches, and obsolete inline-token helpers.
- [ ] T052 [US6] Build focused API-access settings components for personal credentials, service-account identity/detail, credential inventory, confirmations, warnings, and transient one-time-secret acknowledgement using existing theme/primitives.
- [ ] T053 [US6] Replace the legacy token UI in workspace settings/API/MCP cards and first-run guidance, while keeping public launch and agent-converse credentials distinctly labelled.
- [ ] T054 [US6] Make frontend adapter/unit tests pass, then make Playwright acceptance journeys pass without asserting cosmetic implementation details.

## Phase 8: Contracts, SDK, documentation, and release validation

- [ ] T055 Generate `backend/openapi.json` and `backend/openapi.yaml` from code-first definitions and run backend OpenAPI/contract drift checks.
- [ ] T056 Run `cd typescript-sdk && pnpm run sync`, commit `typescript-sdk/openapi/` and `typescript-sdk/src/generated/`, then build/test the SDK without advertising bearer-only lifecycle helpers as usable.
- [ ] T057 Regenerate any MCP server OpenAPI/client snapshot from the backend contract and run MCP build, unit, contract, and smoke suites.
- [ ] T058 Read `docs/document-writer-prompt.md`, then update `readme.md`, relevant `docs/` pages, and `docs-portal/content/` pages for personal/service identities, one-time/hash-only secrets, role ceilings, expiry, rotation, hard migration/backup rollback, and current MCP rejection.
- [ ] T059 Update affected local `README.md` briefs and `docs/architecture/code-map.md` only where ownership/public entry points/recurring test paths changed.
- [ ] T060 Verify no docs, UI, examples, or tests instruct users to retrieve/share the removed workspace administrator token; preserve correct separate public-launch and agent-converse terminology.
- [ ] T061 Run focused backend unit/integration/contract suites, frontend unit/Playwright suites, MCP build/test/smoke, SDK sync/build/test, and docs portal lint/build; fix regressions.
- [ ] T062 Run `pnpm run ci:local -- origin/main` (or `--all` if final scope warrants it) and record exact evidence.
- [ ] T063 Perform up to three independent senior-engineer review passes, resolve all material findings, and rerun affected tests after each pass.
- [ ] T064 Perform exactly one engineering-manager review against spec, architecture, observability, migration, generated artifacts, and validation evidence; resolve blockers.
- [ ] T065 Update this task list, commit with a Conventional Commit, push the current branch without renaming it, and create a pull request targeting `main` with local-CI evidence and the destructive migration warning.

## Dependencies

- Foundation T001–T012 blocks all stories.
- US1 establishes personal authentication and the route-policy seam required by US3 and migration cleanup.
- US2 extends the same authenticator/policy with service principals.
- US3 must complete before the old bearer path is removed in US4.
- MCP package work T036/T038/T039 can proceed alongside backend US1–US3, but merged readiness and legacy removal wait for the backend principal boundary.
- Frontend tests can be authored against `contracts/api-access.md` in parallel; frontend integration waits for lifecycle routes.
- OpenAPI/SDK generation and documentation follow stable behavior. Full validation and reviews follow all implementation phases.

## Parallel ownership guide

- Backend owner: `backend/**` except final generated SDK/docs; preserve test-first commits/order.
- Frontend owner: `frontend/**` only.
- MCP package owner: `packages/radioso-mcp-server/**` only.
- Integrator: spec task state, backend merged MCP seam if not otherwise assigned, generated snapshots, documentation, cross-package validation, reviews, and PR.
