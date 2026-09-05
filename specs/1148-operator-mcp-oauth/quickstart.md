# Quickstart Validation: Operator MCP With Delegated OAuth

## Recorded Phase 1 evidence

- Frozen local build identities: Codex CLI `0.149.0`; Claude Code `2.1.149`.
  Codex has partial exact-build evidence described below, but no named client
  has completed every lifecycle gate, so all fixtures remain `verified: false`;
  ChatGPT is also unverified.
- The initial contract command failed operationally because the new workspace
  package had not yet been installed (`vitest: command not found`); this was not
  accepted as TDD evidence. The isolated handler then produced an assertion-level
  red with
  `pnpm --dir packages/radioso-mcp-server exec vitest run tests/operatorRequestHandler.test.ts`:
  `1 test failed`, `expected 501 to be 200`. After implementation, the same
  command passed 3 tests.
- Green foundation evidence captured on 2026-09-04:
  `pnpm --dir packages/operator-mcp-contract check` passed 6 tests and TypeScript;
  the local fake-AS/resource test first failed with
  `fake operator journey not implemented`, then its focused journey plus handler
  suite passed 4 tests; full `pnpm --dir packages/radioso-mcp-server test`
  passed 74 tests in 20 files; MCP build passed. The focused backend domain,
  environment, and descriptor-disposition suite passed 16 tests. The fake journey covers
  discovery, S256 authorization/callback, one-time code exchange, stateless
  list/call, refresh rotation/replay denial, revocation, and post-revoke 401.
- Before a named client can be advertised, capture its exact-build discovery,
  authorization callback, list, call, refresh, and revoke transcript. The local
  fake-AS/resource journey exercises only Radioso's proposed wire profile; it is
  not MCP SDK or real-client conformance and is not a substitute for this gate.

## Recorded final validation

Validated on 2026-09-04 after merging the current `origin/main` (including the
workspace-setting proposal, realtime, and crawler changes):

- Backend unit: 577 files and 5,545 tests passed.
- Backend contract: 58 files and 412 tests passed.
- Backend integration, using the dedicated disposable Operator MCP database:
  156 files passed, 1 skipped; 944 tests passed, 7 skipped.
- Backend build, architecture validation, schema snapshot check, and generated
  Kysely type check passed.
- Operator MCP contract: build plus 6 tests passed.
- Standalone MCP: build and 90 tests passed; HTTP and Redis smokes passed and
  preserved the existing `/mcp` `ask_agent` flow.
- Frontend: 163 files and 1,364 tests passed; lint completed with one existing
  unused-variable warning in `tests/e2e/copilot.spec.ts`; production build passed.
  The production-server Operator MCP Playwright journey passed all 8 scenarios.
- TypeScript SDK: OpenAPI sync, build, and 27 tests passed. Root API-contract
  drift validation passed.
- Docs portal lint and production build passed.
- Terraform recursive formatting check and validation passed.

The named Codex CLI, Claude Code, and ChatGPT fixtures remain deliberately
unverified and unavailable. This validation does not claim real-client or MCP
SDK conformance, and no act capability is admitted.

## Recorded Codex CLI compatibility evidence

Validated locally on 2026-09-05 with Codex CLI `0.149.0` against separate
Radioso backend and standalone MCP processes:

- OAuth discovery succeeded through a Client ID Metadata Document after the
  authorization server advertised CIMD support. Codex's literal
  `127.0.0.1` callback was pinned; its additional `localhost` fallback was not
  admitted as an authorization target.
- Browser-bound consent, authorization-code exchange, standard MCP
  `2025-06-18` initialization, tool listing, and one real
  `workspace_settings` invocation succeeded. The result included the expected
  workspace dashboard route.
- Dashboard revocation immediately revoked the grant and refresh lineage.
- After forced access-token expiry, Radioso returned a protected-resource
  challenge with `error="invalid_token"`. Codex did not attempt its stored
  refresh credential, and the lineage remained at generation 1. `codex mcp
  logout` removed only the local credential and did not call Radioso's
  revocation endpoint.

Because the exact-build refresh gate did not pass, the Codex named setup
artifact remains unavailable. These results support the generic, explicitly
unverified connection path; they do not satisfy the named-client release gate.

## Prerequisites

- PostgreSQL and the normal Radioso backend/frontend stack.
- Standalone MCP service with a public canonical operator resource.
- Matching exact-byte `OPERATOR_MCP_INTERNAL_SECRET` in backend and standalone
  environments; a production-safe value is not committed.
- Operator MCP explicitly enabled and at least one designated workspace allowed
  into the limited rollout.

## 1. Discovery and consent

1. Request `/operator/mcp` without a credential and verify `401` points to the
   path-specific protected-resource metadata.
2. Follow authorization metadata with a supported client, S256 challenge, exact
   resource, and read/probe/propose scopes.
3. Sign in on the dedicated consent page, select one accessible workspace,
   approve a strict scope subset, and independently deny `offline_access`.
4. Exchange the one-time code and verify the access token is short-lived and no
   refresh token is returned.
5. Replay the code, change redirect/resource/verifier, and verify safe failure.

## 2. Current authority and catalog

1. List tools as users with different roles and verify only the approved/current
   intersection appears.
2. Invoke `workspace_settings`; verify bounded safe settings and a dashboard URL.
3. Demote or remove the user, then route the next list/call to another instance;
   verify immediate denial even with the same access token and cached tool name.
4. Present agent, personal, service-account, public-chat, and wrong-audience
   credentials to `/operator/mcp`; verify all fail before catalog discovery.

## 3. Probe budget

1. Invoke `retrieval_probe` with an explicit agent and query.
2. Start parallel calls against two standalone/backend instances and verify
   total admitted verification cost never exceeds six units in 60 seconds.
3. Verify customer content is bounded in the result and absent from logs,
   traces, metrics, audit metadata, and invocation receipts.

## 4. Proposal provenance

1. Invoke `propose_ingestion_settings` with a stable operation identity.
2. Repeat concurrently and after a simulated lost response; verify one budget
   reservation and one proposal.
3. Confirm the proposal references the operator MCP invocation, no Ray
   conversation exists, and the returned URL opens the reusable dashboard card.
4. Apply or dismiss using a currently authorized dashboard session. Verify no
   MCP apply/dismiss tool exists.

## 5. Refresh replay and revocation

1. Reauthorize with explicit `offline_access` approval.
2. Refresh once and verify rotation.
3. Submit the consumed refresh generation again, including concurrently; verify
   the whole lineage is revoked and the successor cannot be used.
4. Authorize two clients, revoke one in the dashboard, and verify the other
   remains active.

## 6. Dashboard setup

1. Start only in API Access settings and select each named client surface.
2. Verify a handoff is shown only for a complete passing versioned fixture;
   otherwise show exact no-secret config or an unavailable state.
3. Use Generic MCP and verify it is labeled unverified.
4. Verify connection state appears only after a validated OAuth grant and uses
   the deployment's canonical resource.

## 7. Regression and release gate

1. Run existing agent MCP tests and smokes with operator MCP both disabled and
   enabled. `/mcp` must still expose only `ask_agent`.
2. Run backend, frontend, SDK, schema, OpenAPI, and architecture validation.
3. Confirm no act tool appears and the deployment reports limited-rollout state.
   General availability must remain unavailable until a named owner-approved act
   passes the separate queue/retry/client matrix gate.
