# Tasks: Operator MCP With Delegated OAuth

**Input**: Design documents from `/specs/1148-operator-mcp-oauth/`
**Prerequisites**: approved spec.md, plan.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend and standalone runtime tasks follow red/green ordering.
Frontend visible journeys use Playwright; frontend unit tests are limited to API,
runtime-config, artifact, and state logic.

## Phase 1: Setup And Protocol Feasibility

**Purpose**: Establish the shared cross-process boundary and prove the required
stateless protocol without touching the compatibility-protected agent runtime.

- [X] T001 Create the minimal `packages/operator-mcp-contract/package.json` and `tsconfig.json`, then register its workspace dependencies in the root lockfile, `backend/package.json`, and `packages/radioso-mcp-server/package.json` so assertion-level tests can execute
- [X] T002 Create DTO/proof/replay contract tests in `packages/operator-mcp-contract/tests/operatorMcpContract.test.ts` and stateless/no-initialize `2026-07-28` request profile tests in `packages/radioso-mcp-server/tests/operatorProtocol.test.ts`; the executable transport red/green is captured by T004-T005
- [X] T003 Implement the canonical DTO schemas and HMAC proof codec in `packages/operator-mcp-contract/src/index.ts` until the contract half of T002 passes
- [X] T004 Add an assertion-level failing isolated dispatcher test in `packages/radioso-mcp-server/tests/operatorRequestHandler.test.ts` after the test runner/import graph is operational, and record its exact failure
- [X] T005 Add an isolated stateless operator request-handler feasibility implementation that passes T004 without mounting or changing the existing `/mcp` route in `packages/radioso-mcp-server/src/operator/requestHandler.ts`
- [X] T006 Freeze Codex CLI 0.149.0 and Claude Code 2.1.149 fixture identities; add an automated local fake-AS/resource discovery, callback, stateless list, call, refresh, and revoke journey for the shared profile; require actual named-client transcripts before setting either fixture `verified: true`; keep ChatGPT explicitly unverified until hosted evidence exists in `packages/radioso-mcp-server/tests/fixtures/operator-mcp-clients/` and `tests/operatorCompatibility.test.ts`
- [X] T007 Add operator-resource environment parsing tests in `packages/radioso-mcp-server/tests/config.test.ts` and `backend/tests/unit/operatorMcp/operator-mcp-env.test.ts`
- [X] T008 Add fail-closed operator enablement, canonical origins, internal secret, lifetime, externally monotonic `OPERATOR_MCP_CREDENTIAL_EPOCH`, and rollout configuration in `packages/radioso-mcp-server/src/config.ts`, `backend/src/app/config/env.ts`, and `.env.example`; persisted epoch/fingerprint readiness is implemented under T024-T025
- [X] T009 Run the focused contract/protocol/compatibility tests and the full existing MCP suite green, then record exact commands and results in `specs/1148-operator-mcp-oauth/quickstart.md`; no named client may be advertised as supported while its exact-build fixture is unverified

**Checkpoint**: Shared contract and isolated operator handler are green for
Radioso's proposed stateless `2026-07-28` wire profile; this is not an MCP SDK
or named-client conformance claim. Every named-client support claim has a
frozen, passing exact-build fixture; existing `/mcp` tests remain green. If an
exact client journey cannot be executed, its artifact remains unavailable and
the gap is recorded rather than deferring a red test.

---

## Phase 2: Foundational Authorization, Persistence, And Catalog Seams

**Purpose**: Create the security and persistence substrate that blocks every user story.

- [X] T010 Add failing pure domain tests for scopes, exact audience, redirects, PKCE, lifetimes, digest hygiene, client normalization, and safe OAuth errors in `backend/tests/unit/operatorMcp/operator-mcp-domain.test.ts`
- [X] T011 Implement pure inbound authorization rules and schemas in `backend/src/modules/operatorMcpAuthorization/domain.ts` and `contracts.ts` until T010 passes
- [X] T012 Add failing internal proof signature, expiry, method/path/body binding, wrong-key, credential/admission identity, exact issued-scope ceiling, client version/snapshot, external credential epoch, and canonical decimal version tests in `backend/tests/unit/operatorMcp/operator-mcp-proof.test.ts`
- [X] T013 Implement the backend proof adapter around `@radioso/operator-mcp-contract` in `backend/src/modules/operatorMcpAuthorization/proof.ts` until T012 passes
- [X] T014 Add failing exhaustive MCP disposition/parity tests for first-party and contributed descriptors in `backend/tests/unit/operatorCopilot/operator-mcp-disposition.test.ts`
- [X] T015 Add required eligible/excluded descriptor disposition types and the initial three-tool limited catalog map in `backend/src/modules/operatorCopilot/contracts.ts`, `operatorMcpDisposition.ts`, and `contribution.ts` until T014 passes
- [X] T016 Add failing proposal and replay-evidence exact-one-origin, foreign-key, retention, and existing dashboard-proposal regression tests in the existing proposal unit suites and `backend/tests/integration/operatorMcp/operator-mcp-proposal.integration.test.ts`
- [X] T017 Add failing authorization repository integration tests for immutable client metadata snapshots, transaction/code binding, grant replacement/revision, exact issued scope ceilings, client revocation, token digests, atomic refresh rotation/replay, and externally monotonic credential epochs in `backend/tests/integration/operatorMcp/operator-mcp-authorization-repository.integration.test.ts`
- [X] T018 Add failing Operator Copilot repository integration tests for proof replay, invocation reconciliation, input-digest conflicts, and rolling budget reservations in `backend/tests/integration/operatorCopilot/operator-mcp-invocation-repository.integration.test.ts`
- [X] T019 Add the next ordered `backend/src/db/migrations/<next>_operator_mcp_oauth.sql` with immutable client snapshots, transactions, grants, exact-scope credentials, deployment credential state, invocations, `users.disabled_at`, and exact-one proposal/evidence origin foreign keys and retention-safe cascades
- [X] T020 Implement shared Kysely mapping helpers in `backend/src/db/repositories/operatorMcpRowMapper.ts`
- [X] T021 Implement the authorization-owned repository port/adapter in `backend/src/modules/operatorMcpAuthorization/contracts.ts` and `backend/src/db/repositories/operatorMcpAuthorizationRepository.ts` until T017 passes
- [X] T022 Implement the Operator Copilot-owned invocation/budget repository port/adapter in `backend/src/modules/operatorCopilot/mcpContracts.ts` and `backend/src/db/repositories/operatorMcpInvocationRepository.ts` until T018 passes
- [X] T023 Refactor `CopilotProposal`, proposal repositories, proposal tools, and replay-evidence ownership to a discriminated conversation-or-operator-invocation origin in `backend/src/modules/operatorCopilot/contracts.ts`, `tools/shared.ts`, `service.ts`, `backend/src/db/repositories/copilotRepository.ts`, and `copilotReplayEvidenceRepository.ts` until T016 passes
- [X] T024 Add failing lifecycle tests proving membership/workspace/account/user deletion, real user disablement, client revocation, explicit epoch/key rotation, old-database+old-key restore under a newer external epoch, and overlapping mismatched replicas revoke/fail readiness in `backend/tests/integration/operatorMcp/operator-mcp-lifecycle.integration.test.ts`
- [X] T025 Extend the existing machine-access lifecycle port/repository/service and composition wiring, and make normal dashboard/realtime session authentication reject `users.disabled_at`, in `backend/src/modules/machineAccess/`, `backend/src/modules/auth/services/authService.ts`, auth repositories, `backend/src/app/http/middleware/requireSession.ts`, `backend/src/db/repositories/personalCredentialLifecycleRepository.ts`, and `backend/src/app/server/builders/infra.ts` until T024 and existing auth regressions pass
- [X] T026 Regenerate and verify `backend/src/db/schema.sql` and `backend/src/shared/infra/kysely/schema.ts` with `cd backend && pnpm run db:schema && pnpm run db:types`

**Checkpoint**: Persistent authorization, replay, budget, proposal-origin, and
lifecycle primitives pass real-Postgres tests; no transport is exposed.

---

## Phase 3: User Story 1 — Connect An MCP Client As Myself (Priority: P1)

**Goal**: Complete browser OAuth authorization, explicit consent, code exchange,
refresh, and revocation without a copied Radioso secret.

**Independent Test**: Start with only the operator URL, select one of two
workspaces in browser consent, approve a scope subset, and exchange a code.

### Tests

- [X] T027 [P] [US1] Add failing CIMD immutable-normalization/digest, SSRF, redirect-hop, DNS-pinning, timeout, size, mutation, loopback, and preregistered-client tests in `backend/tests/unit/operatorMcp/operator-mcp-client-metadata.test.ts`
- [X] T028 [P] [US1] Add failing authorize/consent/code/token/refresh/revoke tests including exact issued-scope narrowing, client-version binding, credential epoch, two-tab, state, issuer, PKCE, audience, and refresh-race cases in `backend/tests/unit/operatorMcp/operator-mcp-authorization-service.test.ts`
- [X] T029 [P] [US1] Add failing DCR-not-advertised/disabled and OAuth discovery/form/redirect conformance tests in `backend/tests/contract/operator-mcp-oauth.contract.test.ts`; add bounded DCR tests and implementation before enabling it if a frozen client fixture proves it is required
- [X] T030 [P] [US1] Add failing consent security tests for session/account/user swaps, CSRF, clickjacking, referrer suppression, cache prevention, expired/decided transactions, and safe pre/post-trust errors in `backend/tests/contract/operator-mcp-consent-security.contract.test.ts`
- [X] T031 [P] [US1] Add failing observability contract tests for bounded labels, correct principal/grant/client/workspace attribution, cross-request correlation, and redaction of raw bearer, code, verifier, state, metadata body, scope strings, arguments, and results in the authorization-service and standalone operator observability suites

### Implementation

- [X] T032 [US1] Implement bounded pinned metadata resolution and immutable normalized snapshots using `backend/src/shared/infra/http/publicUrlFetch.ts` from `backend/src/modules/operatorMcpAuthorization/clientMetadataService.ts`
- [X] T033 [US1] Implement transaction, consent, code exchange, exact-scope issuance, refresh replay, client revocation, credential-epoch validation, and revocation orchestration in `backend/src/modules/operatorMcpAuthorization/authorizationService.ts`
- [X] T034 [US1] Implement OAuth metadata/authorize/token/revoke and session-bound transaction routes, with DCR absent, in `backend/src/modules/operatorMcpAuthorization/routes.ts`
- [X] T035 [US1] Wire inbound authorization services through `backend/src/app/server/builders/operatorMcp.ts`, `backend/src/app/server/types.ts`, and `backend/src/app/http/routes/index.ts`
- [X] T036 [US1] Add low-cardinality lifecycle observations, safe audit events, and correlation in `backend/src/modules/operatorMcpAuthorization/authorizationService.ts` until T031 passes

**Checkpoint**: US1's backend OAuth/session/consent security contract passes
without exposing tools. The visible browser-consent story is not called complete
until the ordered consent component and Playwright work in T052/T054 passes.

---

## Phase 4: User Story 3 — Use Only Current Operator Capabilities (Priority: P1)

**Goal**: Authorize catalog and invocation from the intersection of the current
grant, membership tenure, role permissions, scope, descriptor disposition, and Ray policy.

**Independent Test**: List as two roles, then demote/remove/revoke and route the
next request to another backend instance; stale authority is denied.

### Tests

- [X] T037 [P] [US3] Add failing credential-ceiling tests for exact issued scopes, live grant narrowing, client version/status, credential epoch, membership tenure, role permissions, workspace/account/user state, and every protected checkpoint in `backend/tests/unit/operatorMcp/operator-mcp-access-evaluator.test.ts`
- [X] T038 [P] [US3] Add failing service-auth request, credential/admission-row revalidation, signed-ceiling cross-check, admission-proof replay, wrong-service/key/descriptor/resource, unsigned-direct-call, and no-catalog-cache route tests in `backend/tests/contract/operator-mcp-internal.contract.test.ts`
- [X] T039 [P] [US3] Add failing cross-instance revoke/demote/disable/tenure-loss/client-revoke/key-rotation/restore coverage across the Operator MCP lifecycle, authorization-repository, and internal-route suites

### Implementation

- [X] T040 [US3] Implement authorization-owned bearer/grant/client/lifecycle/issued-scope validation in `backend/src/modules/operatorMcpAuthorization/credentialValidationService.ts` using narrow account-access and enabled-user ports
- [X] T041 [US3] Extend `CopilotToolInvocationContext` current authorization for descriptor disposition/scope/role/category checks without teaching account access about OAuth in `backend/src/modules/operatorCopilot/contracts.ts` and `authorization.ts`
- [X] T042 [US3] Implement Operator Copilot-owned admission proof issuance, proof consumption, fresh catalog projection, and current descriptor authorization in `backend/src/modules/operatorCopilot/mcpApplicationService.ts`
- [X] T043 [US3] Implement only service-authenticated admission and catalog transport in `backend/src/modules/operatorCopilot/mcpRoutes.ts`; admission delegates credential validation to the narrow authorization service and no response emits a reusable catalog cache hint; invocation routing waits for T064
- [X] T044 [US3] Wire the separate authorization and Operator Copilot application services/repositories in `backend/src/app/server/builders/operatorMcp.ts`

**Checkpoint**: US3 authorization is coherent across replicas and independent of
the standalone MCP transport.

---

## Phase 5: User Story 2 — Add Radioso From The Dashboard (Priority: P1)

**Goal**: Let a user select a named or generic client and complete exact,
artifact-backed no-secret setup from Settings → API access.

**Independent Test**: Starting only in the dashboard, select each client surface
and receive its verified handoff or explicit unverified/unavailable guidance.

### Tests

- [X] T045 [P] [US2] Add failing setup-artifact completeness, exact verified-build gating, canonical-resource insertion, and no-secret tests in `backend/tests/unit/operatorMcp/operator-mcp-setup-artifacts.test.ts`
- [X] T046 [P] [US2] Add failing setup-only backing-route tests with existing session, workspace, role, and CSRF middleware in `backend/tests/contract/operator-mcp-dashboard.contract.test.ts`; inventory tests wait for T055
- [X] T047 [P] [US2] Add failing frontend runtime-config and operator API adapter tests in `frontend/tests/unit/api-operator-mcp.test.ts` and `runtime-config.test.ts`

### Implementation

- [X] T048 [US2] Implement versioned Codex CLI/desktop/IDE, Claude Code, ChatGPT, and generic setup artifacts outside OAuth in `backend/src/modules/operatorMcpSetup/setupArtifacts.ts` and `packages/radioso-mcp-server/tests/fixtures/operator-mcp-clients/`; unverified fixtures produce unavailable guidance
- [X] T049 [US2] Implement only `/api/v1/workspaces/{workspaceId}/operator-mcp/setup` availability through authenticated dashboard routes in `backend/src/modules/operatorMcpSetup/routes.ts`; it does not own or query grants
- [X] T050 [US2] Add a distinct `operatorMcpUrl` to `frontend/app/runtime-config/route.ts`, `frontend/lib/runtime-config.ts`, and `frontend/hooks/use-runtime-config.ts`
- [X] T051 [US2] Implement the typed dashboard adapter in `frontend/lib/api-operator-mcp.ts` and export it from `frontend/lib/api.ts`
- [X] T052 [US2] Implement the dedicated authenticated consent surface with transaction loading/decision states in `frontend/app/oauth/operator-mcp/consent/page.tsx` and `frontend/components/operator-mcp/operator-mcp-consent.tsx`
- [X] T053 [US2] Implement the client chooser/setup/unavailable states in `frontend/components/dashboard/settings/operator-mcp-access-card.tsx` and compose it from `api-access-panel.tsx`
- [X] T054 [US2] Add the chooser/setup/availability and full consent Playwright journey after backing routes and components exist, covering sign-in return, two workspaces, no-access state, rendered client identity/origin/redirect host, external-data and loopback/private-scheme warnings, scope/offline narrowing, approve/deny/cancel, refresh/reload, expired/already-decided transaction, account/session swap rejection, redirect completion, and frontend response headers for frame denial, no-referrer, and no-store in `frontend/tests/e2e/operator-mcp-oauth.spec.ts`

**Checkpoint**: US2 setup is usable and does not infer connection from a UI choice.

---

## Phase 6: User Story 5 — Review And Revoke Connected Clients (Priority: P2)

**Goal**: Show authoritative own/workspace grant inventory and permit safe self
or owner/admin revocation.

**Independent Test**: Authorize two clients, inspect safe metadata, revoke one,
and verify only its lineage fails on next use.

### Tests

- [X] T055 [P] [US5] Add failing own/admin inventory, detail, existing-admin-middleware authorization, client revocation, and idempotent grant revocation service/route tests in `backend/tests/unit/operatorMcp/operator-mcp-grant-service.test.ts` and `backend/tests/contract/operator-mcp-dashboard.contract.test.ts`

### Implementation

- [X] T056 [US5] Implement only `/api/v1/workspaces/{workspaceId}/operator-mcp/grants` inventory/detail/self-or-admin grant and client revocation in `backend/src/modules/operatorMcpAuthorization/grantService.ts` and auth-owned dashboard grant routes; setup remains in `operatorMcpSetup`
- [X] T057 [US5] Register public setup, dashboard inventory/detail/revoke, and consent-transaction JSON schemas through `backend/src/app/http/openapi/paths/operatorMcpPaths.ts`, `openApiPaths.ts`, and `openApiRegistry.ts`; keep OAuth redirects/forms and internal Operator Copilot routes out of SDK convenience ownership (AGENTS.md's `document.ts` path is stale)
- [X] T058 [US5] Add authoritative grant rows, client detail/status/version, recent-use, and revoke confirmation to `frontend/components/dashboard/settings/operator-mcp-access-card.tsx`
- [X] T059 [US5] Extend Playwright with grant/client inventory, detail, confirm/revoke, owner/admin enforcement, and two-client isolation after T056-T058 are green in `frontend/tests/e2e/operator-mcp-oauth.spec.ts`

**Checkpoint**: US5 grant management and US1 browser consent are end-to-end complete.

---

## Phase 7: User Story 4 — Diagnose And Propose From An External Agent (Priority: P2)

**Goal**: Invoke the initial read/probe/propose tools directly with durable
budgeting, reconciliation, bounded results, and invocation-backed proposals.

**Independent Test**: Read settings, run retrieval diagnosis, and create one
ingestion-settings proposal without a Ray model turn or synthetic conversation.

### Tests

- [X] T060 [P] [US4] Add failing generic catalog mapping, schema parity, guessed-name, stale-catalog, fresh-list, and pre/post-result reauthorization tests in `backend/tests/unit/operatorCopilot/operator-mcp-catalog.test.ts`
- [X] T061 [P] [US4] Add failing atomic rolling-budget, refund boundary, keyed input digest, mismatch, concurrent retry, proof consumption, and lost-response tests in `backend/tests/integration/operatorCopilot/operator-mcp-invocation-repository.integration.test.ts`
- [X] T062 [P] [US4] Add failing invocation-origin proposal/evidence FK, exact-one-origin, persistence/retention, grant-revocation, and dashboard-review integration tests plus a proposal deep-link/review/apply/dismiss Playwright journey in `backend/tests/integration/operatorCopilot/operator-mcp-proposal.integration.test.ts` and `frontend/tests/e2e/operator-mcp-oauth.spec.ts`

### Implementation

- [X] T063 [US4] Implement generic descriptor contract mapping and direct invocation in `backend/src/modules/operatorCopilot/mcpCatalog.ts`
- [X] T064 [US4] Implement the service-authenticated invocation route plus durable reservation, reconciliation, proof consumption, and safe invocation outcomes in Operator Copilot's `backend/src/modules/operatorCopilot/mcpRoutes.ts` and `mcpApplicationService.ts` using `operatorMcpInvocationRepository.ts`
- [X] T065 [US4] Enable `workspace_settings`, `retrieval_probe`, and `propose_ingestion_settings` through explicit MCP-safe adapters in `backend/src/modules/operatorCopilot/operatorMcpDisposition.ts` and affected tool helpers
- [X] T066 [US4] Add a conversation-independent proposal deep link in `frontend/app/oauth/operator-mcp/proposal/[proposalId]/page.tsx` with a review surface reusing `frontend/components/dashboard/copilot-proposal-card.tsx`

**Checkpoint**: US4 works entirely through backend internal contracts; no act or queue path is eligible.

---

## Phase 8: User Story 6 — Operate Across Supported MCP Hosts (Priority: P3)

**Goal**: Mount the separate stateless protected resource, integrate supported
clients, preserve agent MCP, and fail independently.

**Independent Test**: Complete discovery/list/read/probe/propose/refresh/revoke
through the standalone service while existing `/mcp` still exposes only `ask_agent`.

### Tests

- [X] T067 [P] [US6] Add failing standalone adapter signature/redaction/timeout tests in `packages/radioso-mcp-server/tests/operatorBackendAdapter.test.ts`
- [X] T068 [P] [US6] Extend operator protocol tests for protected-resource metadata, 401/403 challenges, Bearer-only transport, version/method-first parsing, stateless list/call, bounded bodies, and no catalog caching in `packages/radioso-mcp-server/tests/operatorProtocol.test.ts`
- [X] T069 [P] [US6] Add operator enabled/disabled/degraded, fixed-safe-field audit attribution/redaction (including descriptor identity, capability shape, and calling surface as audit fields but never metric labels), bounded source/principal flood, rate-limit, readiness, and existing agent route isolation tests before T074 in `packages/radioso-mcp-server/tests/operatorRouteIsolation.test.ts` and `operatorObservability.test.ts`
- [X] T070 [US6] Add multi-instance standalone/backend compatibility tests and exact-build fixture assertions in `packages/radioso-mcp-server/tests/operatorCompatibility.test.ts`; verified support requires captured discovery, callback, list, call, refresh, and revoke evidence

### Implementation

- [X] T071 [US6] Implement the signed backend adapter in `packages/radioso-mcp-server/src/operator/backendAdapter.ts`
- [X] T072 [US6] Complete protected-resource metadata, Bearer challenges, and stateless method dispatch in `packages/radioso-mcp-server/src/operator/protectedResource.ts` and `requestHandler.ts`
- [X] T073 [US6] Mount `/operator/mcp` and its path-specific well-known metadata as independent siblings in `packages/radioso-mcp-server/src/http/createHttpServer.ts` and `runtime.ts`
- [X] T074 [US6] Add separate low-cardinality operator rate-limit/readiness/audit observations and raw-bearer redaction tests without modifying `server.ts`, `SessionServerManager`, agent auth, Redis session state, or `ask_agent`
- [X] T075 [US6] Add Terraform enablement, canonical URL output, separate generated secret, external credential epoch, rollout allowlist, verification budget, and key-rotation/restore guidance in `infra/terraform/variables.tf`, `compute.tf`, and `outputs.tf`, then run `terraform fmt -check -recursive` and `terraform validate` in each affected root

**Checkpoint**: The transport is code-complete and dark when every named fixture
is still unverified. Limited rollout may expose only named clients with captured
exact-build evidence; GA remains gated because no act is exposed.

---

## Phase 9: Polish, Generated Contracts, Documentation, And Validation

- [X] T076 Read `docs/document-writer-prompt.md`, then update `readme.md`, `docs/operator-mcp.md`, `docs/mcp-client-setup.md`, `packages/radioso-mcp-server/README.md`, local READMEs, and `docs/architecture/code-map.md`
- [X] T077 [P] Update `docs-portal/content/guides/mcp-server.mdx`, `guides/authentication.mdx`, `operators/copilot.mdx`, and `operators/deployment.mdx` with verified-client status and the limited-rollout/GA-act distinction
- [X] T078 Restore the documented `sync:openapi` script/generator in `packages/radioso-mcp-server/package.json` if absent; regenerate with `pnpm --dir backend run generate:openapi`, `pnpm --dir typescript-sdk run sync`, and `pnpm --dir packages/radioso-mcp-server run sync:openapi`; then run root `pnpm run check:api-contracts`, backend `pnpm run test:contract`, TypeScript SDK build/test, and MCP build/test; commit backend OpenAPI, SDK snapshots/generated types, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts`
- [X] T079 Run backend focused unit/integration/contract/composition/build/architecture/schema checks and record exact commands/results or environmental gaps in `specs/1148-operator-mcp-oauth/quickstart.md`
- [X] T080 Run `packages/operator-mcp-contract` checks plus MCP build/test/smoke and verify existing agent MCP `ask_agent` regressions in enabled and disabled configurations
- [X] T081 Run frontend unit/typecheck/lint/build and Playwright operator MCP journeys, then TypeScript SDK build/test
- [X] T082 Audit changed files for credentials/customer-content leakage, raw-bearer redaction, audit attribution, label cardinality, client fixture evidence, queue-contract impact, and full FR/SC traceability; keep GA disabled with no admitted act

---

## Dependencies & Execution Order

- Phase 1 blocks every other phase.
- Phase 2 blocks all user-story work.
- US1 and US3 establish authentication/authorization before US2/US5 UI and US4 tools.
- US4 proposal work requires the Phase 2 transport-neutral proposal origin.
- US6 requires the internal backend contracts from US3/US4.
- Phase 9 follows all desired user stories.
- Within every backend phase, tests are authored and observed failing before the corresponding implementation task.

## Parallel Opportunities

- Once Phase 2 lands, metadata tests (US1), grant-intersection tests (US3), and artifact/API tests (US2) touch disjoint files.
- Backend dashboard APIs and frontend adapter/component work are parallel after schemas stabilize.
- Standalone operator runtime work is isolated from backend domain files once the shared contract passes.
- Documentation and docs-portal prose are parallel after behavior and generated contracts are stable.

## Implementation Strategy

1. Prove the exact operator protocol and cross-process proof boundary.
2. Land the authorization/persistence/proposal-origin substrate under TDD without exposing a route.
3. Complete OAuth and authoritative current-access behavior.
4. Add dashboard setup/inventory/consent.
5. Enable the small read/probe/propose vertical slice.
6. Mount the standalone operator resource and validate supported clients.
7. Regenerate contracts/docs and run all regressions.

The MVP is US1 + US3 (secure delegated connection and current-authority tool
listing). The approved limited release adds US2, US4, US5, and US6. General
availability is not part of this implementation because FR-023 deliberately
requires a separately owner-approved act and client-matrix gate.
