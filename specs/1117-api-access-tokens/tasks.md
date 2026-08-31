# Tasks: Personal API Tokens and Workspace Service Accounts

**Input**: Approved design artifacts in `specs/1117-api-access-tokens/`
**Tests**: Backend tasks are ordered test-first. Visible frontend journeys use Playwright; adapter/state logic may use unit tests.
**Organization**: Tasks are grouped by prerequisite and user story. `[P]` means the task can run in parallel because it owns disjoint files and has no incomplete dependency.

## Phase 1: Foundation and explicit boundaries

- [x] T001 Capture the authenticated-route eligibility coverage map and permanent Ray exclusions in `backend/src/app/http/apiPrincipalRoutePolicy.ts` tests and `backend/src/modules/operatorCopilot/` coverage tests before adding production policy.
- [x] T002 [P] Add failing credential value-object tests for NFC labels, control characters, prefixes, required expiries, secure maxima, and token parsing in `backend/tests/unit/machineAccess/credential-values.test.ts`.
- [x] T003 [P] Add failing service-principal transition and effective-role tests in `backend/tests/unit/machineAccess/service-account-service.test.ts` and `backend/tests/unit/machineAccess/service-credential-service.test.ts`.
- [x] T004 [P] Add failing personal tenure/effective-role tests in `backend/tests/unit/machineAccess/personal-credential-service.test.ts` and `backend/tests/unit/machineAccess/api-principal-authenticator.test.ts`.
- [x] T005 Add migration/repository integration tests covering new tables, constraints, hash-only rows, quotas, conditional rotation, stable pagination, and idempotent legacy tombstones in `backend/tests/integration/machine-access-repository.integration.test.ts` and `backend/tests/integration/machine-access-migration.integration.test.ts`.
- [x] T006 Add migration `backend/src/db/migrations/158_machine_access.sql` with `workspace_service_accounts`, `api_credentials`, and `legacy_workspace_credential_tombstones`, then irreversibly tombstone/destroy legacy workspace-token authenticating material.
- [x] T007 Update Kysely database types/schema snapshots for migration 158 in the existing `backend/src/db/` generated/type ownership files.
- [x] T008 Implement machine-access domain values/entities/errors and narrow repository/tenure/role/clock/secret/audit/last-use ports in `backend/src/modules/machineAccess/` until T002–T004 pass.
- [x] T009 Implement versioned opaque token generation, safe-prefix extraction, and non-reversible verifier matching in `backend/src/modules/machineAccess/credentialSecretCodec.ts`.
- [x] T010 Implement transactional Kysely adapters in `backend/src/db/repositories/machineAccessRepository.ts` and focused lifecycle/authority repositories until T005 passes.
- [x] T011 Wire machine-access repositories, codec, clock, role/tenure resolver, audit sink, and last-use recorder in `backend/src/app/server/builders/infra.ts` and `accessAuth.ts` without putting domain rules in composition.
- [x] T012 Add bounded machine-access audit/metric/diagnostic payload tests and implementations that exclude raw headers, secrets, verifier values, labels, and high-cardinality metric attributes.

## Phase 2: User Story 1 — Mint a personal API token (P1)

**Goal**: A signed-in user can issue and manage their own live-role-bounded personal credentials, with administrators able only to audit safe metadata and revoke others.

- [x] T013 [US1] Add failing application-service tests for personal issuance, 10-active quota, ceiling selection, one-time secret response, hash-only persistence, owner-only mutation, admin safe audit/revoke, and cross-workspace denial in `backend/tests/unit/machineAccess/personal-credential-service.test.ts`.
- [x] T014 [US1] Add failing authentication tests for live role demotion, promotion ceiling, tenure end/reinvite, deletion, expiry boundaries, malformed/unknown/revoked uniform failures, and last-use success-only updates in `backend/tests/unit/machineAccess/api-principal-authenticator.test.ts`.
- [x] T015 [US1] Implement `PersonalCredentialService` and `ApiPrincipalAuthenticator` in `backend/src/modules/machineAccess/services/` until T013–T014 pass.
- [x] T016 [US1] Add failing Supertest coverage for session-only personal lifecycle routes, cookie precedence, CSRF, pagination, conflict mapping, one-time response, and bearer-fallback denial in `backend/tests/integration/api-access-personal.integration.test.ts`.
- [x] T017 [US1] Implement dedicated schemas/presenters/routes in `backend/src/app/http/schemas/apiAccessSchemas.ts`, `presenters/apiAccessPresenter.ts`, and `routes/apiAccessRoutes.ts` as transport-only adapters.
- [x] T018 [US1] Delegate ordinary bearer authentication from `backend/src/modules/auth/services/authService.ts` and `backend/src/app/http/middleware/requireApiToken.ts` to the principal authenticator without adding lifecycle logic there.
- [x] T019 [US1] Implement the explicit default-deny principal-kind route policy in `backend/src/app/http/apiPrincipalRoutePolicy.ts`, declare the initial eligible ordinary routes, and make T001 pass.
- [x] T020 [US1] Register personal-token paths and schemas in focused code-first files under `backend/src/app/http/openapi/paths/` and `backend/src/app/http/openapi/schemas/`.

## Phase 3: User Story 2 — Create a workspace service account (P1)

**Goal**: Administrators manage durable service identities whose independently replaceable credentials share live principal authority and audit identity.

- [x] T021 [US2] Add failing service-account application tests for create-with-first-credential atomicity, 50-account quota, live role, creator independence, and enable/disable/archive transitions in `backend/tests/unit/machineAccess/service-account-service.test.ts`.
- [x] T022 [US2] Add failing service-credential tests for five-active quota, sibling isolation, multi-credential shared principal, expiry, relabel, revoke, lost response recovery, zero-downtime overlap, and conditional immediate rotation races in `backend/tests/unit/machineAccess/service-credential-service.test.ts`.
- [x] T023 [US2] Implement focused service-account and service-credential orchestration in `ServiceAccountService` under `backend/src/modules/machineAccess/services/` until T021–T022 pass.
- [x] T024 [US2] Extend principal-authenticator tests for enabled/disabled/archived service principals, live role changes, deleted workspace, credential isolation, and stable principal/specific credential attribution.
- [x] T025 [US2] Implement service-principal authentication and best-effort aggregate/per-credential last-use recording without coupling request authorization to metadata success.
- [x] T026 [US2] Add failing Supertest coverage for admin-only service-account and credential lifecycle endpoints, revisions, pagination, quotas, role ceiling, cross-workspace denial, and bearer-fallback denial in `backend/tests/integration/api-access-service-accounts.integration.test.ts`.
- [x] T027 [US2] Extend dedicated API-access schemas/presenters/routes with service-account and credential endpoints until T026 passes.
- [x] T028 [US2] Register service-account and service-credential paths/schemas in the code-first OpenAPI registry.

## Phase 4: User Story 3 — Enforce live role-bounded access (P1)

**Goal**: Browser, personal, and service principals use centralized permissions while sensitive routes remain attributable-session-only.

- [x] T029 [US3] Add contract tests that enumerate every authenticated public route with permission, allowed principal kinds, and session-only status in `backend/tests/contract/api-principal-route-policy.contract.test.ts`.
- [x] T030 [US3] Add end-to-end authorization matrix tests for session/personal/service/public-launch/agent-converse credentials in `backend/tests/contract/token-authorization.contract.test.ts`.
- [x] T031 [US3] Add the three session capabilities to `backend/src/modules/account/services/accountAccessService.ts` and its focused unit tests while keeping role mapping as its only new responsibility.
- [x] T032 [US3] Apply the central principal-kind route policy at HTTP composition/registration so undeclared routes deny machine credentials and lifecycle/account/organization/membership/provider-secret/public-launch surfaces remain session-only.
- [x] T033 [US3] Include stable principal kind/ID and credential ID in existing audit context for otherwise-audited eligible API requests, with safe authorization-denial observability.
- [x] T034 [US3] Add/update authenticated rate-limit tests and keying so personal credentials and service credentials cannot collapse into the removed shared workspace-token bucket.

## Phase 5: User Story 4 — Replace the shared administrator token safely (P1)

**Goal**: Upgrade irreversibly removes legacy authentication and purges controlled MCP session stores before readiness.

- [x] T035 [US4] Add backend migration failure/retry and non-enumerating legacy-rejection cases to `backend/tests/integration/machine-access-migration.integration.test.ts` and remove obsolete success expectations from legacy workspace-token tests.
- [x] T036 [P] [US4] Add failing MCP package tests for personal/service rejection, idempotent in-memory and Redis legacy-session purge, unavailable-store fail-closed readiness/retry, and stale external credential rejection in `packages/radioso-mcp-server/tests/`.
- [x] T037 [P] [US4] Add integration/contract tests proving merged MCP remains unmounted, the removed context-exchange route returns `404`, new REST credentials are not accepted by MCP, and purge-only upgrade readiness is enforced.
- [x] T038 [US4] Extend the MCP session-store contract and in-memory/Redis implementations under `packages/radioso-mcp-server/src/` with idempotent namespace-safe legacy purge and readiness state until T036 passes.
- [x] T039 [US4] Add standalone HTTP startup/readiness retry coordination under `packages/radioso-mcp-server/src/`, accept only the original agent-converse grant at `/mcp`, and remove the unsupported stdio entrypoint.
- [x] T040 [US4] Add purge-only merged-upgrade readiness lifecycle at `backend/src/app/server/mcpMount.ts` while keeping the merged MCP route unmounted and transport free of credential lifecycle rules.
- [x] T041 [US4] Remove `/api/v1/workspace/mcp/context` and lexical token-shape classification; keep personal/service credentials REST-only and standalone MCP on the agent-converse grant boundary.
- [x] T042 [US4] Retire legacy workspace-token repository/composition/routes only after all callers migrate; retain unrelated uses of `WORKSPACE_TOKEN_SECRET` such as access grants when still required.

## Phase 6: User Story 5 — Manage lifecycle, inventory, and warnings (P2)

**Goal**: Safe inventories, expiry warnings, audits, and lifecycle races are operationally trustworthy.

- [x] T043 [US5] Add tests for stable page ordering/default/max bounds, safe owner/creator/lineage metadata, aggregate last use, expiry warning thresholds, idempotent revocation, and archived-history retention.
- [x] T044 [US5] Implement a composition-owned daily expiry-warning lifecycle with an injected clock/event sink and idempotent 30/7/1-day event behavior; do not add AMQP payloads.
- [x] T045 [US5] Implement a coalesced asynchronous last-use writer that meets the five-minute bound and records only successful credential authentication.
- [x] T046 [US5] Complete lifecycle audit events and automatic invalidation/tombstone audit attribution with bounded reason and request correlation fields.
- [x] T047 [US5] Add API-access summary endpoint tests/implementation for effective role, capabilities, lifetime defaults/maxima, limits, legacy migration status, and `mcpCredentialSupport: "unsupported"`.

## Phase 7: User Story 6 — Configure API access clearly (P2)

**Goal**: Dashboard users create and manage the correct credential type without browser persistence or confusing it with public/agent-converse credentials.

- [x] T048 [P] [US6] Add failing frontend unit tests for the session-only API-access adapter, safe response mapping, one-time-secret transient state, and removal of automatic bearer retry/storage in `frontend/tests/unit/api-access-api.test.ts` and `frontend/tests/unit/workspace-api-auth.test.ts`.
- [x] T049 [P] [US6] Add failing Playwright journeys for personal creation/lifecycle, service-account lifecycle/multiple credentials, roles/permissions, one-time acknowledgement/copy, pagination, warnings, migration notice, and storage absence in `frontend/tests/e2e/api-access-settings.spec.ts`.
- [x] T050 [US6] Implement `frontend/lib/api-api-access.ts` using session cookies, CSRF, and `X-Workspace-Id`; expose typed personal/service lifecycle operations without accepting or retaining a bearer secret.
- [x] T051 [US6] Remove automatic workspace-token fetch, bearer fallback, and `radioso.workspaceTokens` persistence from `frontend/lib/api-client.ts`, `frontend/lib/api-storage.ts`, auth/workspace contexts, direct chat/routine/connector fetches, and obsolete inline-token helpers.
- [x] T052 [US6] Build focused API-access settings components for personal credentials, service-account identity/detail, credential inventory, confirmations, warnings, and transient one-time-secret acknowledgement using existing theme/primitives.
- [x] T053 [US6] Replace the legacy token UI in workspace settings/API/MCP cards and first-run guidance, while keeping public launch and agent-converse credentials distinctly labelled.
- [x] T054 [US6] Make frontend adapter/unit tests pass, then make Playwright acceptance journeys pass without asserting cosmetic implementation details.

## Phase 8: Contracts, SDK, documentation, and release validation

- [x] T055 Generate `backend/openapi.json` and `backend/openapi.yaml` from code-first definitions and run backend OpenAPI/contract drift checks.
- [x] T056 Run `cd typescript-sdk && pnpm run sync`, commit `typescript-sdk/openapi/` and `typescript-sdk/src/generated/`, then build/test the SDK without advertising bearer-only lifecycle helpers as usable.
- [x] T057 Regenerate any MCP server OpenAPI/client snapshot from the backend contract and run MCP build, unit, contract, and smoke suites.
- [x] T058 Read `docs/document-writer-prompt.md`, then update `readme.md`, relevant `docs/` pages, and `docs-portal/content/` pages for personal/service identities, one-time/hash-only secrets, role ceilings, expiry, rotation, hard migration/backup rollback, and current MCP rejection.
- [x] T059 Update affected local `README.md` briefs and `docs/architecture/code-map.md` only where ownership/public entry points/recurring test paths changed.
- [x] T060 Verify no docs, UI, examples, or tests instruct users to retrieve/share the removed workspace administrator token; preserve correct separate public-launch and agent-converse terminology.
- [x] T061 Run focused backend unit/integration/contract suites, frontend unit/Playwright suites, MCP build/test/smoke, SDK sync/build/test, and docs portal lint/build; fix regressions.
- [x] T062 Run `pnpm run ci:local -- origin/main` (or `--all` if final scope warrants it) and record exact evidence.
- [x] T063 Perform up to three independent senior-engineer review passes, resolve all material findings, and rerun affected tests after each pass.
- [x] T064 Perform exactly one engineering-manager review against spec, architecture, observability, migration, generated artifacts, and validation evidence; resolve blockers.
- [x] T065 Update this task list, commit with a Conventional Commit, push the current branch without renaming it, and create a pull request targeting `main` with local-CI evidence and the destructive migration warning.

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
