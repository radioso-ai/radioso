# Tasks: Hosted App Runtime — Release A

**Input**: `plan.md`, `spec.md`, `architecture.md` in this folder
**Organization**: One pull request per phase. Each PR is independently reviewable, green on `pnpm run lint`, `pnpm run lint:dead-code:ci`, and its package tests, and ships its docs. Backend tests are written and observed failing before implementation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel with neighbours (different files, no dependency)
- **[Story]**: spec user story; `US1` install, `US2` publish, `US4` durable work, `US5` storage, `US7` lifecycle, `MIG` connector migration

---

## PR 1 — Contract package `@radioso/app-contract`

**Goal**: Provider-neutral schemas and pure validation that every later PR imports. No backend changes. Locks the shapes listed under "Contract Decisions" in `plan.md`.

- [x] T001 [US2] Create `packages/app-contract/` mirroring `packages/mcp-source-proof` (package.json with `build`/`test`, `tsconfig.json`, `tsconfig.build.json`, `src/index.ts`, `tests/`). Add `zod` as a dependency. Confirm `pnpm install` links it and knip treats `src/index.ts` as the entry.
- [x] T002 [P] [US2] Write failing tests `tests/identifiers.test.ts` for AppId, ContributionId, digest, semver acceptance and rejection.
- [x] T003 [P] [US2] Write failing tests `tests/configuration.test.ts` and `tests/connections.test.ts`: field vocabulary, `connection_slot` references, `generated_secret` and `secret_fields` slots, reserved `oauth2` slot parses but is flagged by policy.
- [x] T004 [P] [US2] Write failing tests `tests/storage.test.ts`: collection declaration, scalar-only indexes, `allowedOperations`, quotas, retention; scoped operation schemas (`get`, `put`, `delete`, `query`).
- [x] T005 [P] [US2] Write failing tests `tests/contributions.test.ts`: the three Release A kinds accept valid declarations; reserved kinds parse by header only; unknown kinds fail; execution class derivation per kind.
- [x] T006 [P] [US2] Write failing tests `tests/runtime.test.ts` and `tests/jobs.test.ts`: `InvocationRequest`/`InvocationResponse` per input kind, host capability request/response union, error code enum, bounded error message, wake-up envelope rejects any extra key.
- [x] T007 [US2] Write failing tests `tests/validate.test.ts`: every cross-reference rule in `plan.md` produces one issue with a stable `code` and `path`; policy with `supportedContributionKinds` rejects reserved kinds as `unsupported_contribution_kind`; a fully valid manifest returns `ok: true` with the parsed manifest.
- [x] T008 [US2] Write failing test `tests/wordpressFixture.test.ts` that loads `fixtures/reference/wordpress.manifest.json` and expects `validateManifest` to accept it under the Release A policy, and that snapshot-asserts its contribution ids (`site_content` document source, `content_push` webhook handler, `content_poll` scheduled task), its collection (`sync_state`), its slots (`site_credentials`, `webhook_secret`), and its configuration-bound destination.
- [x] T009 Implement `src/identifiers.ts`, `src/configuration.ts`, `src/connections.ts`, `src/destinations.ts`, `src/storage.ts`, `src/setup.ts` until T002–T004 pass.
- [x] T010 Implement `src/contributions.ts`, `src/manifest.ts` until T005 passes.
- [x] T011 Implement `src/runtime.ts`, `src/jobs.ts` until T006 passes.
- [x] T012 Implement `src/validate.ts` (zod parse, then cross-reference pass, then policy pass; collect all issues rather than stopping at the first) until T007 passes.
- [x] T013 Author `fixtures/reference/wordpress.manifest.json` from today's connector: configuration `site_url` (url), `post_types` (text, default `page,post`, matching today's connector), `poll_interval_sec` (number, default 0); slot `site_credentials` (`wp_username` non-sensitive, `wp_application_password` sensitive); slot `webhook_secret` (generated); destination `site` bound to `site_url`, https only; collection `sync_state` with fields `cursor` (string), `updated_at` (timestamp), one index on `updated_at`; contributions `site_content`, `content_push` (hmac_sha256 over raw body, header `X-Radioso-Signature`, prefix `sha256=`, 2 MiB body, 300 s replay window), `content_poll` (`interval_from_configuration` on `poll_interval_sec`, min 60 s, `skip` overlap, 600 s max, 5 attempts exponential 30 s to 900 s); setup guide sections for installing the companion plugin and pasting the endpoint and secret; companion asset `radioso-sync.zip` with a placeholder digest clearly marked for PR 5. Until T008 passes.
- [x] T016 Address the independent (Codex gpt-5.6-sol) review of PR #1208: protocol alignment with architecture §7, strict manifests, discriminated configuration fields, schema versions, `documentSources`, `indexedFields` policy, `disabledValue`, http destinations, typed capability results with `requestId`, bounds, fixture fidelity, interoperability vectors. Review saved at `.context/codex-review-1208.md`.
- [x] T014 Export the public surface from `src/index.ts`; run `pnpm --filter @radioso/app-contract build test`, `pnpm run lint`, `pnpm run lint:dead-code:ci` from the repo root. Fix findings rather than suppress.
- [x] T015 Docs: write `docs/apps/app-manifest.md` (author-facing reference for every manifest section, the three Release A contribution kinds, reserved kinds, storage declarations, setup guide) and `docs/apps/runtime-protocol.md` (invocation envelopes, host capability calls, error codes, wake-up envelope) following `docs/document-writer-prompt.md`; add `packages/app-contract/README.md` brief; add an "Apps" area to `docs/architecture/code-map.md` pointing at the package and this spec.

**PR 1 gate**: package tests green; lint and dead-code ratchet green; WordPress fixture validates; docs present.

---

## PR 2 — `apps` domain: releases, installations, plans, grants, connections, lifecycle

- [ ] T101 [US2] Failing repository and domain tests: built-in release registry admits a manifest under the Release A policy and records `admissionPolicyVersion`; digests are verified against the registry's artifact catalogue; a second admission of the same version with different content is rejected.
- [ ] T102 [US1] Failing tests: deterministic installation plan (checksum, expiry) covering release, workspace, configuration values, connection bindings, grants, destinations, collections; a stale plan is rejected on apply.
- [ ] T103 [US1] Failing tests: connection binding stores sensitive fields through the existing secret path and never returns them; `generated_secret` is minted once and shown once.
- [ ] T104 [US7] Failing tests: lifecycle state machine `planned → provisioning → staged → testing → ready → active`, `disabled`, `removing → removed`; saga cursor resumes after a simulated crash at each step; compensation never re-runs a completed external step.
- [ ] T105 [US1] Failing route tests: inspect, plan, apply, get installation, disable, enable, remove, data disposition; current-principal re-check on every mutation (FR-027a).
- [ ] T106 Migrations for `app_releases`, `app_installations`, `app_installation_plans`, `app_grants`, `app_connections`, `app_lifecycle_operations`; regenerate both DB snapshots (`db:types` and `db:schema`).
- [ ] T107 Implement domain, repositories, services, routes, OpenAPI registration; regenerate `backend/openapi.*`, run `cd typescript-sdk && pnpm run sync`; check the MCP package's OpenAPI copy.
- [ ] T108 Composition module `backend/src/app/composition/apps.ts` with the built-in registry wired from a static list (empty until PR 5 registers WordPress).
- [ ] T109 Audit events `app.release.*`, `app.installation.*`, `app.grant.*`, `app.connection.*`; Ray coverage: read-only installation inspection tool plus coverage-map exclusions for apply, remove, and disposition with reasons.
- [ ] T110 Docs: `docs/apps/release-admission.md`, operator page skeleton `docs-portal/content/operators/apps.mdx` (lifecycle states, plan review), code-map update.

---

## PR 3 — `appStorage` domain

- [ ] T201 [US5] Failing tests: put/get/delete/query scoped by workspace + installation; cross-installation read with matching keys returns `not_found`; undeclared collection, invalid record, undeclared index, oversize record, quota overflow, stale `expectedVersion` each return their error code and leave existing records unchanged.
- [ ] T202 [US5] Failing tests: schema compatibility matrix accepts additive field changes and rejects removals or type changes; TTL expiry hides expired records and a sweeper deletes them.
- [ ] T203 [US5] Failing tests: disable revokes access without deletion; removal disposition export (JSON lines per collection), retain-for-N-days, delete; workspace deletion cascades.
- [ ] T204 Migration for `app_storage_records` and `app_storage_index_entries`; both DB snapshots.
- [ ] T205 Implement domain, repository, service, composition module; audit `app.data.*`.
- [ ] T206 Docs: `docs/apps/storage.md`; operator page section on data disposition.

---

## PR 4 — `appRuntime`: gateway, identity, host capabilities, App Jobs, webhook and schedule admission, local-process provider

- [ ] T301 [US4] Failing tests: `app_jobs` compare-and-set lease, heartbeat extension limit, exponential backoff with jitter, per-class attempt ceiling, dead-letter visibility, cancellation on disable; consumer reloads installation, grant, release, and quarantine state before leasing.
- [ ] T302 [US4] Failing tests: webhook admission authenticates HMAC over the raw body using the bound `generated_secret`, enforces `maxBodyBytes`, rejects replays inside the window, persists the job, then acknowledges 202; duplicate delivery ids map to one idempotency key; removed installation returns 404 without waking a process.
- [ ] T303 [US4] Failing tests: schedule admission creates at most one job per installation, contribution, and occurrence; `skip` overlap policy; interval read from configuration with the declared minimum enforced.
- [ ] T304 [US1] Failing tests: invocation identity token bound to installation, contribution, invocation, execution class, expiry; reuse for another contribution or after disable fails at the host capability layer.
- [ ] T305 [US4] Failing tests for host capabilities: `documents.ingest`/`documents.delete` go through `documents/appIngestionPort.ts` with provenance and external id namespace enforced; `storage.*` delegate to `appStorage`; `egress.fetch` allows only declared destinations, resolves configuration-bound hosts, blocks loopback, link-local, private, and metadata ranges at connect time, follows redirects only within policy, injects the connection credential server-side.
- [ ] T306 [US1] Failing tests for the runtime provider port and the local-process provider: start one process per installation with only `APP_INSTALLATION_ID`, `APP_GATEWAY_URL`, and the identity bootstrap; health and drain; stop on disable; crash marks the installation degraded and opens the circuit after N failures; no provider configured yields typed `unavailable`.
- [ ] T307 Migration for `app_jobs`, `app_webhook_deliveries`, `app_schedule_occurrences`; both DB snapshots.
- [ ] T308 Implement domain, services, provider, gateway routes, host capability routes, webhook ingress route, job consumer; composition module with disabled default; environment variables in `.env.example` and Compose.
- [ ] T309 Observability: logs, metrics, spans, and `app.security.*` audit for denied egress and identity misuse, per plan.
- [ ] T310 Docs: `docs/apps/runtime-protocol.md` completed with lifecycle of a job and a webhook; queue docs pointer; operator page section on health and queued work.

---

## PR 5 — WordPress App, App runtime client, conformance harness

- [ ] T401 Add `apps/*` to `pnpm-workspace.yaml` and knip workspaces. Create `packages/app-runtime-client` (handler registration, host capability client, protocol validation using `@radioso/app-contract`) with tests.
- [ ] T402 [US4] Failing conformance tests in `backend/tests/conformance/apps/` that run a manifest's fixtures against a real gateway and a fake App process: webhook delivery → ingest; scheduled poll with checkpoint round-trip through `sync_state`; backfill with deletion propagation; failure and retry paths. Fixture selection is by declared contributions, never by app id.
- [ ] T403 Implement `apps/wordpress`: manifest (moved from the PR 1 fixture, digest of the companion zip computed at build), `content_push` handler mapping the existing PHP payload (`event`, `post`, `fields`) to `documents.ingest`/`documents.delete` with `wp_post_<id>` external ids, `content_poll` handler using WordPress REST via `egress.fetch` with the `site_credentials` slot and a `sync_state` checkpoint, backfill handler. No imports from `backend/`.
- [ ] T404 Register the WordPress release in the built-in registry (composition) so it appears in the catalog.
- [ ] T405 Docs: `docs/apps/authoring-an-app.md` (walkthrough using WordPress as the worked example), `packages/wordpress-companion/README.md` updated for the installation-scoped endpoint.

---

## PR 6 — Migration, legacy forwarding, connector retirement, Apps dashboard, docs

- [ ] T501 [MIG] Failing tests: per-workspace migration creates installation, connection, configuration, and `sync_state` cursor from `connector_configs` + `connector_sync_state`; existing documents keep external ids and provenance; idempotent re-run is a no-op; failure leaves the workspace on the connector.
- [ ] T502 [MIG] Failing tests: `POST /api/connectors/wordpress/:workspaceId/webhook` forwards to the installation-scoped gateway endpoint with the same secret for migrated workspaces and returns 410 for unmigrated ones after the deprecation flag flips.
- [ ] T503 [MIG] Implement migration command and forwarding; delete `backend/src/modules/connectors/plugins/wordpress/`, its registration, routes, and tests; `ConnectorPlugin` remains for Slack and WhatsApp only.
- [ ] T504 [US1] Playwright: Apps catalog lists WordPress; install flow renders configuration form and connection slots from the manifest; setup guide and companion download render from manifest data; safe test; health; disable; remove with disposition choice.
- [ ] T505 [US1] Implement the Apps pages and manifest-driven components; replace the hardcoded WordPress entries in `add-document-menu.tsx`, `connector-setup-dialog.tsx`, `documents-view.tsx` with the generic installed-Apps list; unit tests only for manifest-to-form mapping.
- [ ] T506 Repository search gate: zero `wordpress` identifiers in `backend/src/modules/` (excluding `apps/wordpress`), `frontend/`, and the connector registry; add to the CI script.
- [ ] T507 Docs: finish `docs-portal/content/operators/apps.mdx`; rewrite `docs-portal/content/operators/wordpress-connector.mdx` as the WordPress App page; update `readme.md` ingestion section; final code-map pass.

**Release A gate**: spec Release A gate satisfied; SC-015 and SC-016 evidenced in the PR 6 description.
