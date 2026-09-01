# Implementation Plan: Workspace and Agent API Credentials

**Branch**: `role-based-mcp-access-design` | **Date**: 2026-08-31 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification in `specs/1117-api-access-tokens/spec.md`

## Summary

Replace the recoverable workspace-wide administrator token with hash-only personal API credentials and first-class workspace service accounts whose credentials are independently replaceable. The `machineAccess` domain owns those role-bearing principals while the existing `accessGrants` aggregate owns role-free, one-agent channel credentials with distinct MCP and REST audiences. Lifecycle APIs remain interactive-session-only; the REST channel adds an explicit bound-agent chat route and MCP narrows its agent surface to stateful chat only. The dashboard separates service accounts into their own Settings page and embeds each channel's credential lifecycle in its channel card. OpenAPI, SDK snapshots, MCP runtime/package contracts, and documentation move together.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 with Next.js 16 App Router
**Primary Dependencies**: Express, Zod, Kysely, Pino, OpenTelemetry, React, Radix/shadcn primitives, Redis-backed MCP session store
**Storage**: PostgreSQL 16; Redis or memory for controlled MCP runtime sessions
**Testing**: Vitest, Supertest, Playwright, MCP package contract/smoke tests, TypeScript SDK snapshot/build tests
**Target Platform**: Self-hosted Linux containers and host services; modern web browsers
**Project Type**: pnpm workspace containing backend, frontend, MCP package, SDK, and documentation portal
**Performance Goals**: Credential verification remains a single indexed lookup plus live-principal resolution; successful last-use metadata is visible within five minutes; inventories remain bounded and use stable pagination
**Constraints**: Hash-only secrets; one-time plaintext display; personal lifetime at most 90 days; service credential lifetime at most 365 days; default-deny route eligibility; session-only lifecycle; non-enumerating failures; no secret-bearing logs, traces, metrics, audits, storage, or analytics
**Scale/Scope**: Up to 10 active personal credentials per user/workspace, 50 non-archived service accounts per workspace, 5 active credentials per service account, and list pages of 50 by default/100 maximum

## Constitution Check

*GATE: Passed before research and re-checked after contract/data-model design.*

- The specification is approved and contains measurable scenarios, settled matrices, migration behavior, and explicit exclusions.
- Backend stories use test-first ordering. Frontend visible journeys use Playwright; unit tests cover only adapters/state/validation.
- The existing Node/React/PostgreSQL stack is unchanged. This feature has no LLM/provider or prompt-template behavior.
- Secrets are generated only after limits and transitions validate, returned once, and persisted only as versioned non-reversible hashes plus safe prefixes. No new environment secret is required.
- `backend/src/modules/machineAccess/` owns role-bearing workspace credential decisions; `backend/src/modules/accessGrants/` owns agent/audience binding and channel secret lifecycle. HTTP, persistence, account access, chat, MCP, and composition depend on narrow ports and do not absorb lifecycle rules.
- `backend/src/app/composition/` wires repositories, authenticator, last-use writer, expiry-warning lifecycle, route policy, and MCP purge/readiness integration.
- Code-first OpenAPI sources change first; `backend/openapi.json`, `backend/openapi.yaml`, and `typescript-sdk/` snapshots are regenerated.
- Message-queue review: document-worker dispatch, AMQP payloads, retry semantics, tests, and docs are unaffected because credential authentication terminates at HTTP/MCP boundaries. Expiry warning scanning is an application lifecycle, not a worker contract.
- Documentation updates cover setup/authentication, API/SDK use, workspace-versus-agent credential selection, MCP chat-only behavior, migration/release guidance, and product UI.
- Ray/Operator Copilot gets permanent coverage-map exclusions for every lifecycle operation because identity, access, and secret management remain on its never-list.

## Project Structure

### Documentation (this feature)

```text
specs/1117-api-access-tokens/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/api-access.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/machineAccess/       # domain services, ports, values, principal resolution
│   ├── db/migrations/               # 157 destructive legacy migration + new tables
│   ├── db/repositories/             # Kysely persistence adapters
│   ├── app/http/                    # session-only routes, schemas, presenters, route policy
│   ├── app/http/openapi/            # code-first API-access contract
│   └── app/composition/             # runtime construction and lifecycle wiring
├── tests/{unit,integration,contract}/
├── openapi.json                     # generated
└── openapi.yaml                     # generated

frontend/
├── app/ and components/             # API-access settings and one-time secret flows
├── lib/                             # session-authenticated adapters; no token cache/fallback
└── tests/e2e/                        # visible lifecycle and storage journeys

packages/radioso-mcp-server/
├── src/                             # audience preflight, chat-only catalogue, purge, readiness
└── tests/                           # audience isolation, chat-only surface, and purge behavior

typescript-sdk/
├── openapi/                         # synchronized contract snapshot
└── src/generated/                   # generated SDK types/client snapshot

docs/ and docs-portal/content/       # operator, REST/SDK, migration, and MCP guidance
```

**Structure Decision**: Use the existing web-application workspace. The new domain is isolated in the backend rather than extending legacy workspace-token services. Frontend lifecycle calls live in a focused API-access adapter and components; the generic client only owns session request mechanics. MCP stores implement purge/readiness through a narrow runtime-store contract. Generated artifacts remain outputs of repository commands.

## Module Ownership & Seams

- **Transport Layer**: Focused API-access and agent-channel lifecycle routes validate session/CSRF, path ownership, input/output schemas, pagination, and capability calls. The REST agent-chat route authenticates an expected audience and verifies the path binding before calling chat. Transport never generates/hashes tokens, decides roles, or selects a default agent.
- **Orchestration Layer**: Machine credential and service-account services coordinate role-bearing lifecycle. `AccessGrantService` coordinates role-free channel issue/list/rotate/revoke/resolve lifecycle. Existing chat orchestration receives a resolved agent principal and remains credential-agnostic.
- **Domain Layer**: `machineAccess` owns personal tenure binding, service-principal state, effective-role calculation, credential state/rotation, expiry, and quotas. `accessGrants` owns immutable agent/workspace/audience binding, secret lifecycle, and evaluation. `AccountAccessService` alone maps roles to permissions.
- **Persistence/Integration Layer**: Kysely repositories store principals, credentials, grants, and tombstones; secret codecs retain only versioned hash verifiers and safe prefixes for newly issued credentials; MCP runtime stores implement idempotent legacy-session purge; last-use updates remain best effort.
- **Application Composition**: Composition builds repositories and services, injects expected-audience authenticators into REST/MCP transports, registers workspace default-deny route policy, starts expiry scanning, and gates MCP readiness on purge completion.
- **Files Kept Small**: `AuthService`, `AccountAccessService`, chat services, account route assemblies, `mcpMount.ts`, generic frontend API clients, workspace Settings composition, and MCP transport entry points receive narrow calls only—not cross-domain lifecycle rules.
- **Planned Extractions**: Reuse the access-grant repository/service port; add expected-audience resolution and an agent-chat principal middleware; extract shared agent credential management UI used inside separate MCP and API cards; split API-access presentation by Settings page without duplicating data-fetching rules.
- **Required Refactor Stories**: Before bearer rollout, replace implicit workspace-token auth with an explicit principal/route policy seam and replace dashboard bearer fallback/storage with session requests. These are functional prerequisites, not deferred cleanup.

## Delivery Phases

1. Add failing domain/repository/migration tests, migration 158, machine-access ports/entities, storage adapters, crypto codec, composition, and safe audit/telemetry shapes.
2. Add failing personal-token and service-account lifecycle/auth tests, then implement session-only routes, default-deny route eligibility, live role/tenure enforcement, rotation/quota/pagination, OpenAPI definitions, and scheduled warning/last-use behavior.
3. Add migration and MCP tests, then implement verifier destruction, tombstones, controlled runtime-store purge/readiness/retry, and rejection of every new API credential class across merged, standalone, stdio, and agent-converse paths.
4. Add frontend adapter/state tests and Playwright journeys, then remove workspace-token caching/fallback and deliver separate personal/service-account lifecycle UI with transient one-time-secret handling.
5. Regenerate OpenAPI and SDK snapshots, update docs/release guidance after reading the documentation prompt, run focused suites and local CI, and complete senior-engineer plus engineering-manager review.
6. Harden integration-test database isolation with failing guard/script regressions, harness-owned disposable database marking, removal of development database aliasing, scoped repository cleanup, a real PostgreSQL negative/positive smoke test, and one additional senior-engineer review. The already-completed single engineering-manager review is not repeated because this follow-up does not change product scope or architecture.
7. Add failing access-grant, REST route, MCP catalogue/auth, OpenAPI, frontend adapter, and Playwright tests for role-free agent channel credentials and the revised Settings information architecture. Implement expected-audience grant resolution, explicit bound-agent REST chat, MCP chat-only enforcement, unified channel-card lifecycle UI, `Primary` service credential creation, SDK/docs regeneration, real local API/browser/MCP verification, and a fresh independent engineering review because this phase expands product architecture.

## Observability & Audit

- Emit safe lifecycle audit events for create, issue, relabel, rotate, revoke, role/state changes, migration, expiry warning, and automatic invalidation with bounded reasons and stable IDs only.
- Add bounded authentication result metrics by principal kind/outcome/reason and separate authorization denials. Never label metrics with user, workspace, principal, credential, label, or prefix values.
- Record last use asynchronously/best-effort after successful authentication and coalesce writes within five minutes; metadata failure neither grants nor denies access.
- Add startup/readiness logging for MCP purge attempts and failures without credential/session material. A configured inaccessible store remains unready and retries.
- Correlate credential-authenticated audited API actions with stable principal and credential IDs. Do not record raw headers or hash/verifier values.
- Record channel credential issue/rotate/revoke and bounded authentication outcomes with audience, grant, workspace, and agent IDs in audit metadata; keep audience/outcome/reason as the only metric labels. Existing chat tracing already covers turn latency and failures, so this phase adds no duplicate chat span or prompt/content logging.

## Integration Database Safety Follow-up

The local validation incident exposed a test-infrastructure boundary failure rather than an API-access migration defect: the development launcher aliased `INTEGRATION_DATABASE_URL` to `DATABASE_URL`, and local CI trusted an inherited integration URL. A destructive repository test could therefore target the persistent development database. The follow-up hardening uses these boundaries:

- **Guard ownership**: the dependency-free `packages/integration-test-support/` policy compares live PostgreSQL cluster/database identities, requires an explicit test-only name, and verifies a database marker. Backend and Enterprise Edition own only their PostgreSQL reader adapters; the policy does not know application schema, accounts, workspaces, or product credentials.
- **Harness ownership**: local CI and GitHub CI provision and mark disposable databases before invoking backend or Enterprise Edition database suites. Ordinary development launchers know only the application database and never synthesize an integration-test URL.
- **Test ownership**: repository tests create uniquely identified fixtures and clean up only those fixtures. They do not truncate shared application tables.
- **Dependency direction**: Vitest global setup and the explicit preparation command depend on the narrow guard; application/runtime modules never depend on test infrastructure. Shell harnesses call the preparation command rather than duplicating marker rules.
- **Override rule**: manually prepared databases require an exact acknowledged database name matching the connection target. A boolean bypass is intentionally unsupported.
- **Observability**: failures identify only sanitized host/database identity and the missing safety condition. This is test infrastructure, so no runtime metrics, audit events, or OpenTelemetry spans are added.
- **Contract review**: no public API, SDK, MCP, connector, worker, or AMQP contract changes are involved; generated snapshots and queue payloads are unaffected.

## Contract, Migration, and Rollback

- Migration `157` transactionally creates the new schema, records one tombstone per legacy credential, destroys all legacy authenticating material, and removes the old credential relation idempotently.
- There is no compatibility mode or auto-migration into a personal/service credential. Legacy API and MCP use stops immediately.
- Controlled MCP runtime stores purge legacy sessions before readiness; backend verifier removal keeps stale external copies unusable.
- Ordinary routes without an explicit machine-principal policy are denied by default. Lifecycle and other sensitive surfaces require a valid interactive session and never fall back to bearer auth.
- Agent channel credentials are not machine-access principals. They terminate at a dedicated MCP or REST agent-chat authenticator, require an exact persisted audience and agent binding, and cannot enter ordinary workspace route policy.
- Existing `mcp-converse` transport/session paths may remain as internal names, but newly issued MCP grants use the `agent-api` principal kind and the user-facing contract says `MCP credential`. Existing MCP grants are forward-migrated because backward compatibility is not required.
- Document-worker dispatch, AMQP payloads, connector contracts, retries, and queue documentation remain unchanged: both agent transports call the existing synchronous chat boundary and never place credentials in worker payloads.
- Rollback across migration 158 requires a compatible pre-migration database backup; application code alone cannot reconstruct destroyed secrets.

## Planning Tooling Note

The Speckit agent-context updater is intentionally not run: it would generate feature history and technology inventory into the hand-maintained root `AGENTS.md`, directly violating this repository's maintenance instructions. Durable feature context remains in this plan and `docs/architecture/code-map.md` is updated only if ownership actually changes.

## Complexity Tracking

No constitution exceptions are required. The new module and persistence ports are warranted by the distinct domain identity/lifecycle rules and prevent existing authentication, account-access, transport, and MCP components from becoming mixed-responsibility services.
