# Implementation Plan: Hosted App Runtime — Release A

**Branch**: `conversational-agent-plugins` | **Date**: 2026-09-06 | **Spec**: [spec.md](./spec.md) · [architecture.md](./architecture.md)
**Input**: Release A of the Hosted App Runtime specification: the WordPress App delivered over the full App protocol on the local-process provider, retiring the in-process WordPress connector.

## Summary

Release A introduces the App abstraction and proves it with one real App. Six independently reviewable pull requests land, in order: (1) the provider-neutral contract package; (2) the `apps` domain with releases, installations, plans, grants, connections, and lifecycle; (3) the `appStorage` domain; (4) the `appRuntime` domain with the App Gateway, host capabilities, durable App Jobs, webhook and schedule admission, and the local-process runtime provider; (5) the WordPress App as an out-of-process program plus the conformance harness; (6) migration of existing WordPress connector configurations, legacy webhook forwarding, connector retirement, the generic Apps dashboard, and documentation. Every PR is TDD-first on the backend, ships its docs, and passes the workspace lint and dead-code gates.

The rule that shapes every PR: **one architecture**. The WordPress App is written as a third party would write it. Nothing in `backend/src/modules/` may branch on the WordPress App identity, and the App never imports backend modules.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24 (backend, App, contract package); React 19 / Next.js 16 (dashboard)
**Primary Dependencies**: Zod for every schema in the contract package; Express for gateway routes; Kysely for persistence (raw SQL is gated by `checkNoRawSql.mjs`); Pino; Vitest; Playwright
**Storage**: PostgreSQL 16. New tables are Radioso-owned and generic; Apps declare logical collections only
**Testing**: Vitest unit and integration (disposable Postgres via `@radioso/integration-test-support`), Supertest for routes, Playwright for the Apps dashboard journeys, a contract-level conformance harness for App fixtures
**Target Platform**: Compose stack for development and self-hosted; Radioso Cloud later registers a sandbox provider behind the same port
**Project Type**: Web application (backend + frontend) plus workspace packages
**Performance Goals**: SC-006 platform overhead is measured but not gated until Release E; Release A records warm-invocation overhead on the local-process provider
**Constraints**: No first-party shortcut; no App code in API or worker processes; no App-specific branches in generic modules; no raw customer content in logs or metrics; queue envelopes carry only `{ envelopeVersion, appJobId }`
**Scale/Scope**: One App, tens of installations, one App process per installation on the local-process provider

## Constitution Check

- Spec approved by the product owner on 2026-09-06 ("go ahead with implementation") after the one-architecture revision.
- Backend work is TDD: each PR's task list places failing tests before implementation.
- Frontend: the Apps catalog, install, connection, test, health, disable, and removal journeys get Playwright coverage. Unit tests are limited to manifest-to-form mapping and API adapters.
- Stack stays Node.js backend, React frontend, PostgreSQL system of record.
- Secrets: connection values live in the existing encrypted secret path; the local-process provider passes only an installation identity and the gateway address to the App process. New environment variables (`APP_RUNTIME_PROVIDER`, `APP_GATEWAY_INTERNAL_URL`, `APP_LOCAL_PROCESS_ROOT`) are added to `.env.example` and Compose files in PR 4.
- Customer data: FR-025, FR-057, FR-068, FR-069 are restated as tests in PRs 2, 3, and 4 (no secrets in plans, logs, storage records, or frontend state; workspace deletion cascades).
- Module boundaries: `apps` (control plane), `appRuntime` (execution and jobs), `appStorage` (records), gateway transport under `backend/src/app/http/`, contribution adapters in owning modules, composition in `backend/src/app/composition/`.
- Files kept small: `backend/src/app/composition/*` gains one new composition module per domain; `documents` gains one narrow port file; no existing large service absorbs App logic.
- Composition: PR 2, 3, and 4 each add a composition module that assembles repositories, services, the runtime provider, the job dispatcher, and disabled defaults. Product rules never live in composition.
- HTTP contracts: PRs 2, 4, and 6 register routes in `backend/src/app/http/openapi/document.ts`, regenerate `backend/openapi.yaml` and `backend/openapi.json`, run `cd typescript-sdk && pnpm run sync`, and check the MCP package's OpenAPI copy.
- Message-queue impact: reviewed in this plan (see "Message-Queue Review"). Document worker payloads are untouched; App Jobs get their own table and, in Release A, a database-polling consumer. A later AMQP adapter may publish the wake-up envelope only.
- Docs: each PR lists the docs it ships (see per-PR sections). Author-facing docs live under `docs/apps/`; operator docs under `docs-portal/content/operators/`; architecture code map gains an "Apps" area.

## Project Structure

### Documentation (this feature)

```text
specs/1118-hosted-app-runtime/
├── spec.md
├── architecture.md
├── plan.md              # this file
├── tasks.md             # PR-by-PR task list
└── checklists/requirements.md
```

### Source Code (repository root)

```text
packages/app-contract/                 # PR 1: provider-neutral schemas and pure validation
├── src/
│   ├── index.ts                       # public surface (re-exports only)
│   ├── identifiers.ts                 # AppId, ContributionId, CollectionId, digest, semver (structural regexes)
│   ├── configuration.ts               # bounded configuration field vocabulary
│   ├── connections.ts                 # connection slot declarations
│   ├── destinations.ts                # external destination declarations
│   ├── storage.ts                     # collection declarations + scoped storage operations
│   ├── contributions.ts               # closed discriminated contribution catalog
│   ├── setup.ts                       # setup guide + companion asset declarations
│   ├── manifest.ts                    # AppManifest schema
│   ├── runtime.ts                     # invocation request/response, host capability request/response envelopes
│   ├── jobs.ts                        # App Job wake-up envelope
│   └── validate.ts                    # validateManifest: zod parse + cross-reference + supported-kind policy
├── fixtures/reference/wordpress.manifest.json   # conformance vector; relocated to the App package in PR 5
├── tests/*.test.ts
├── README.md
├── package.json, tsconfig.json, tsconfig.build.json

backend/src/modules/apps/              # PR 2: control plane (releases, installations, plans, grants, connections, lifecycle)
backend/src/modules/appStorage/        # PR 3: managed collections
backend/src/modules/appRuntime/        # PR 4: gateway domain, identity, App Jobs, webhook/schedule admission, provider port
backend/src/app/http/apps/             # PR 2/4/6: public routes (dashboard/SDK) and gateway transport (App-facing, webhook ingress)
backend/src/app/composition/apps*.ts   # PR 2/3/4: assembly + disabled defaults
backend/src/modules/documents/appIngestionPort.ts   # PR 4: narrow port the gateway calls

apps/wordpress/                        # PR 5: the WordPress App (own workspace package; added to pnpm-workspace.yaml)
packages/app-runtime-client/           # PR 5: tiny App-side client for the runtime protocol (handlers, host capability calls)
backend/tests/conformance/apps/        # PR 5: harness running fixtures against the protocol

frontend/app/(dashboard)/apps/         # PR 6: Apps catalog, install, detail
frontend/components/dashboard/apps/    # PR 6: manifest-driven forms and setup guide

docs/apps/                             # author-facing: manifest, contributions, runtime protocol, storage, conformance
docs-portal/content/operators/apps.mdx # operator-facing: install, connections, test, health, disable, remove, migration
```

**Structure Decision**: Three backend domains mirror the architecture document's ownership table. Transport for both the public API and the App-facing gateway sits under `backend/src/app/http/apps/` so no domain owns Express. The App lives outside `backend/` and `packages/` in a new `apps/` workspace folder to make the process boundary visible in the repository layout.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/apps/` — public App routes (inspect, plan, apply, lifecycle, health), gateway routes (invocation results, host capability calls), webhook ingress. Translate and authenticate; own no rules.
- **Orchestration Layer**: `apps/services/installationLifecycleService.ts` (saga steps, compensation, resume), `appRuntime/services/appJobConsumer.ts` (lease, invoke, complete), `appRuntime/services/scheduleAdmission.ts`, `appRuntime/services/webhookAdmission.ts`.
- **Domain Layer**: `apps/domain/*` (release admission policy, plan builder and checksum, grant diff, lifecycle state machine), `appStorage/domain/*` (schema compatibility, quota, query bounds), `appRuntime/domain/*` (identity claims, execution-class budgets, circuit state, egress policy).
- **Persistence/Integration Layer**: Kysely repositories per domain; `appRuntime/ports/runtimeProvider.ts` (provision/start/stop/drain/health/invoke), `appRuntime/providers/localProcessProvider.ts`; `appRuntime/ports/egressTransport.ts`; `documents/appIngestionPort.ts`.
- **Application Composition**: `backend/src/app/composition/apps.ts`, `appStorage.ts`, `appRuntime.ts` assemble repositories, services, provider (or the disabled provider when `APP_RUNTIME_PROVIDER` is unset), job consumer lifecycle, and audit/log sinks.
- **Files Kept Small**: `backend/src/app/composition/index.ts` only registers the three new modules; `documents` service files gain a port implementation, not App logic; `connectorRegistry.ts` shrinks in PR 6.
- **Planned Extractions**: `documents/appIngestionPort.ts` (guarded ingest/delete keyed by external ID with provenance), `appRuntime/ports/runtimeProvider.ts`, `appRuntime/ports/egressTransport.ts`, `apps/ports/*` for Ray and HTTP consumers.
- **Required Refactor Stories**: none before PR 1. PR 6 includes the connector-registry cleanup after the WordPress connector is deleted.

## Contract Decisions (PR 1, load-bearing)

These are fixed here so PRs 2–6 build on stable shapes. Anything not listed is an implementation detail of the contract package.

**Identifiers.** `appId` is reverse-DNS lower-case (`ai.radioso.wordpress`). `contributionId`, `collectionId`, `slotId`, `destinationId`, and field keys match `^[a-z][a-z0-9_]{0,63}$`. Digests are `sha256:<64 hex>`. Versions are semver strings validated structurally.

**Versions.** `manifestSchemaVersion: 1` and `runtimeProtocolVersion: 1` are literals. Unknown values fail parsing.

**Manifest top level.** `app { id, name, description, publisher { id, name } }`, `version`, `radiosoCompatibility` (semver range string), `artifact { digest, mediaType, entrypoint? }` where `mediaType` is an enum of `application/vnd.radioso.app.node-bundle.v1+tar` and `application/vnd.oci.image.manifest.v1+json`, `permissions[]` (host capabilities: `documents.ingest`, `documents.delete`, `storage.read`, `storage.write`, `egress.fetch`), `configuration { fields[] }`, `connections { slots[] }`, `destinations[]`, `storageCollections[]`, `contributions[]`, `resourceProfile { memoryMb, cpuMillis, maxConcurrentInvocations, scratchMb }`, `setupGuide?`, `companionAssets?[]`, `conformanceFixtures[]`.

**Configuration fields.** A discriminated union on `type`: `text | number | boolean | select | url | connection_slot`. Defaults are type-checked (`select` defaults must be one of `options`; `number` may carry `min`/`max`); `connection_slot` references a declared slot and carries no default. Secrets never appear here. Every manifest object is `.strict()`: unknown keys fail admission (FR-007).

**Connection slots.** `kind` is `secret_fields` (fields with `sensitive: boolean`) or `generated_secret` (host mints the value, shows it once). `oauth2` is a reserved kind that fails admission in Release A.

**Destinations.** `host` is either `{ kind: "pattern", pattern }` or `{ kind: "configuration", field }` (installation-bound host taken from a `url` configuration field). Plus `protocols` (`https | http`; `http` exists so operators' current plain-http WordPress sites can migrate, and the plan review shows it), `ports?` (omitted means the default port of each declared protocol; explicit means exactly those; a destination-bound URL's effective port must be permitted by every destination bound to that field), `purpose`, `dataClasses[]` (closed enum), and `credentials? { slot, application, required }` where `application` is a closed union (`http_basic` with named username/password fields, `bearer` with a token field, `header` with a header name and value field). `required: false` means the egress broker sends anonymously when the slot is unbound and injects when bound. The App never constructs credentials; the broker applies them per this declaration.

**Storage collections.** `scope: "installation"`, `schemaVersion` (integer), `compatibleReaderVersions[]`, `recordSchema { fields[{ key, type: string|number|boolean|timestamp|json, required }] }`, `indexes[{ id, field }]` (scalar fields only), `quotas { maxRecords, maxRecordBytes }` (`maxRecordBytes` is capped at the bounded-JSON wire limit so no admitted collection promises capacity a message cannot carry), `retention { kind: none|ttl, seconds? }`, `allowedOperations` subset of `get | put | delete | query_by_index`.

**Contributions.** Common header: `id`, `kind`, `displayName`, `description`, `permissions[]` (subset of manifest permissions), `egressDestinations[]`, `deadlineMs`, `availability: optional | required`, `inputSchemaVersion`, `outputSchemaVersion`, `requiredConnectionSlots[]` (a slot is required for an installation only while a contribution that requires it is active, so push-only WordPress sites need no REST credentials). Handler kinds (`external_webhook_handler`, `scheduled_task`) also declare `documentSources[]`: the `document_source` contributions they write through, so document effects carry a stable source identity (FR-015); a handler that requests a document permission must name at least one source. Kinds fully specified in Release A:
- `document_source`: `externalIdNamespace`, `syncModes[]` of `push | poll | backfill`, `contentFormats[]` of `html | markdown | text`, `indexedFields` as `{ policy: "declared", keys[] } | { policy: "dynamic", maxFields }` (indexed-field keys are case-capable, matching today's connector), `backfill?: { checkpointCollection }`. Execution class `scheduled_task` for backfill runs.
- `external_webhook_handler`: `authentication { kind: "hmac_sha256", secretConnectionSlot, secretField?, signatureHeader, signaturePrefix? }` (`secretField` names the signing field when the slot is `secret_fields` and is forbidden for `generated_secret`), `maxBodyBytes`, `replayWindowSeconds`. Execution class `external_webhook`.
- `scheduled_task`: `schedule` is `{ kind: "interval", seconds }` or `{ kind: "interval_from_configuration", field, minSeconds, maxSeconds, disabledValue? }` (a configuration value is valid only when it equals `disabledValue`, which makes the task inactive and must sit below `minSeconds`, or is an integer within `[minSeconds, maxSeconds]`; a `required` scheduled task may not declare `disabledValue`; the referenced field must be required or carry a default that satisfies the same predicate, and schedules sharing a field must agree on the sentinel and share a reachable integer range), `overlapPolicy: skip | queue | replace`, `maxDurationSeconds`, `retry { maxAttempts, backoff { kind: "exponential", baseSeconds, maxSeconds } }`, `checkpointCollection?`. Execution class `scheduled_task`.
Reserved kinds `tool`, `context_provider`, `event_subscription`, `ui`, `pack` parse by header only and fail admission with `unsupported_contribution_kind` until their release. Any other `kind` fails parsing.

**Runtime protocol.** Aligned with architecture.md section 7 "Runtime protocol boundary". `InvocationRequest { protocolVersion, invocationId, installationId, releaseDigest, contributionId, executionClass, inputSchemaVersion, attempt, idempotencyKey, deadlineAt, capabilitySession { token, expiresAt }, context { configuration }, input }`, strict, where `context.configuration` is the installation's effective non-secret configuration (FR-021a): stored values with manifest defaults resolved and then validated by `resolveInstallation`, which accepts only the `AdmittedManifest` that `validateManifest` returns (a frozen, symbol-branded readonly view), so admission is one boundary and a host re-runs `validateManifest` on a stored manifest to regain it; readiness (active contributions: required ones always, schedules disabled by their `disabledValue`; required connection slots) is derived in the same call, so it never depends on a caller-supplied list, with `executionClass` refined against `input.kind` (webhook `{ deliveryId, receivedAt, headers, body: { encoding: "base64", data } }`, scheduled `{ occurrenceId, scheduledFor, checkpoint? }`, backfill `{ requestId, checkpoint? }`). `InvocationResponse` is discriminated on the closed outcome catalog `succeeded | invalid_request | denied | unavailable | rate_limited | retryable_failure | terminal_failure | timed_out | cancelled`; only `succeeded` carries `outputSchemaVersion` and `output`; retryable arms carry `error`, optional `retryAfterSeconds`, and optional progress `checkpoint`; terminal arms carry `error` only. `HealthResponse { protocolVersion, ready, implementedContributionIds }`. Host capability calls (App to gateway) use `HostCapabilityCall { protocolVersion, invocationId, capabilitySession, requestId, request }` where `requestId` is the App-chosen idempotency id stable across retries (FR-043h) and `request` is the discriminated union `documents.ingest`, `documents.delete`, `storage.get`, `storage.put`, `storage.delete`, `storage.query`, `egress.fetch`. Document effects carry `sourceContributionId`; ingest carries bounded `metadata`, `publishedAt`, `modifiedAt`, `author`; the host injects provenance. Results are typed per capability, never `unknown`. Responses are `{ ok: true, capability, result } | { ok: false, error { code, message } }` with error codes `denied | not_found | invalid_input | quota_exceeded | version_conflict | destination_denied | deadline_exceeded | unavailable | internal`. Bounds: JSON values (checkpoints, storage records) limited in depth, keys, array length, string length, and serialized bytes; header maps limited in entry count; base64 bodies validated and capped; `egress.fetch.path` is origin-relative only. Messages are bounded and must not echo payloads. Gateway invariant for document effects: the invoking contribution is derived from the capability session; `sourceContributionId` must be one of that handler's `documentSources` (or the invoking source itself for a backfill); the source's namespace and indexed-field policy are enforced; provenance is injected by the host.

**App Job wake-up envelope.** `{ envelopeVersion: 1, appJobId }`. Nothing else, ever.

**Setup guide and companion assets.** `setupGuide { sections[{ title, paragraphs[], steps?[] }] }` with bounded lengths; `companionAssets[{ id, label, fileName, mediaType, digest }]`.

**validateManifest(manifest, policy)** returns `{ ok: true, manifest } | { ok: false, issues[{ code, path, message }] }`. Policy carries `supportedContributionKinds`, `supportedConnectionKinds`, `supportedPermissions`. Cross-reference checks: unique ids per family (including connection secret-field keys, storage record-field keys, index ids, and handler `documentSources`); contribution permissions ⊆ manifest permissions ⊆ policy permissions; `egressDestinations`, `secretConnectionSlot`, `checkpointCollection`, `connection_slot` fields, `requiredConnectionSlots`, and `interval_from_configuration.field` all resolve; configuration-bound destination hosts reference `url` fields and destinations sharing a field have a non-empty protocol intersection; interval fields are `number`, admit the disabled sentinel, and reach the active range; a required scheduled task declares no disabled sentinel; index fields exist and are scalar; a handler holding a document permission names at least one `document_source`; a webhook handler requires its secret slot and, for a `secret_fields` slot, names a required sensitive `secretField`; a contribution using a destination with required credentials requires that slot; credential-application fields exist, are required, and password/token/header-value fields are sensitive; a credentialed destination discloses the `credentials` data class; conformance fixtures reference declared contributions; a schedule-bound field is required or defaulted, its default satisfies the schedule, schedules sharing a field agree on the sentinel and keep a reachable integer range; destinations sharing a field have a common protocol and port pair, explicit port lists are non-empty, and a destination-bound `url` default satisfies the same URL policy as a stored value. `resolveInstallation(manifest, stored)` is the single door for both effective configuration and readiness: it bounds input, materialises defaults, validates the effective map (types, URL scheme, port, and no userinfo, query, or fragment for destination-bound URLs, select membership, number range, schedule value space), never echoes undeclared keys, and returns a frozen `EffectiveConfiguration` (branded with a non-exported symbol) together with `InstallationReadiness` derived from it, so readiness can never be computed from an unresolved or foreign map.

## Message-Queue Review

- Document worker payloads, `document_processing_jobs`, and AMQP queue names are untouched in Release A.
- App Jobs live in `app_jobs` (PR 4) with compare-and-set leases, attempts, backoff, dead-letter state, and cancellation. The Release A consumer polls Postgres; a future AMQP dispatcher publishes only the wake-up envelope on a separately named queue after its own review.
- Webhook ingress persists the job before acknowledging with 202; App code never runs in the request.
- Retry and dead-letter semantics are documented in `docs/apps/runtime-protocol.md` (PR 4) and queue docs gain a one-paragraph pointer.

## Observability

- Audit families `app.release.*`, `app.installation.*`, `app.grant.*`, `app.connection.*`, `app.data.*`, `app.security.*` (PRs 2, 3, 4, 6) with identities, reason codes, and counts only.
- Structured logs at gateway admission, provider start/stop/health, job lease/complete/dead-letter, webhook admission decisions, egress denials. Never payloads, secrets, or content.
- Metrics with bounded labels (`contribution_kind`, `execution_class`, `outcome`, `admission_reason`, `provider_state`): invocation count and duration, job age and attempts, dead letters, egress denials, provider cold starts.
- Spans: gateway admission → provider acquire → handler → host capability children → response validation.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Three new backend domains and one new workspace folder for one App | The spec's one-architecture rule forbids wrapping the existing connector | Wrapping was proposed and rejected by the product owner on 2026-09-06; it would leave the protocol unproven and keep WordPress branches in the frontend |
| Own job table instead of reusing document worker jobs | Spec FR-043a–g; App work must not share document payload rows or retry rules | A shared table would couple App retries to document worker semantics and queue docs |
