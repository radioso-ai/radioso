# Implementation Plan: Operator MCP With Delegated OAuth

**Branch**: `review-ray-mcp-oauth` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `/specs/1148-operator-mcp-oauth/spec.md`

## Summary

Add a separate, stateless `/operator/mcp` protected resource to the standalone
MCP service. Radioso's backend becomes the inbound OAuth authorization server
for human workspace grants, validates every bearer against authoritative
PostgreSQL state, and supplies single-use internal principal proofs to a generic
Operator Copilot catalog/invocation adapter. The dashboard adds a no-secret
client chooser, consent page, grant inventory, and revocation flow. The limited
rollout exposes one reviewed read, probe, and proposal; acts remain excluded and
general availability remains gated.

## Technical Context

**Language/Version**: TypeScript 5.9 backend/package on Node.js 24; TypeScript 5.7 frontend with React 19 and Next.js 16  
**Primary Dependencies**: Express 4, Zod 3 backend / Zod 4 MCP package, Kysely, PostgreSQL 16, Node crypto, Undici 8, `@modelcontextprotocol/server` 2.x, React Query, Radix/shadcn components  
**Storage**: PostgreSQL 16 for clients, authorization transactions, grants, credential digests, refresh lineages, invocation receipts, budget reservations, reconciliation, and proposal origin  
**Testing**: Vitest, Supertest, real-Postgres integration tests, Playwright, MCP package smoke harnesses, OpenAPI/SDK drift checks  
**Target Platform**: Self-hosted Linux services plus modern browser dashboard and remote MCP hosts  
**Project Type**: pnpm web application monorepo with standalone MCP service  
**Performance Goals**: p95 under one second for metadata, catalog, and authorization decisions excluding human/tool execution; no distributed oversubscription of six verification units per grant per rolling minute  
**Constraints**: MCP `2026-07-28` operator resource only; exact RFC 8707 audience; S256; 15-minute maximum access token; immediate next-request revocation across replicas; bounded SSRF-safe metadata; no raw credentials or customer content in observability; existing agent MCP unchanged  
**Scale/Scope**: One new backend domain/module, one narrow cross-process contract package, one migration family, three internal capability routes, OAuth and lifecycle routes, one standalone operator route, one dashboard card and consent page, initial three-tool limited catalog, three named client setup families plus generic setup

## Constitution Check

*GATE: PASS before research; rechecked PASS after design.*

- Approved spec exists and every task traces to a story or functional requirement.
- Backend work is split into red/green slices; tests precede each implementation task.
- User-visible setup, consent, inventory, revocation, and proposal review use Playwright; unit tests cover only adapter/state logic.
- Stack remains Node.js, React, PostgreSQL, and the existing MCP packages. No new LLM integration or prompt is introduced.
- New internal secret is environment-backed, documented in `.env.example`, never committed, and validated fail-closed.
- Opaque credential digests, least-privilege scope intersection, bounded results, current-role checks, safe audit, and immediate revocation protect customer data.
- Transport, OAuth lifecycle, account authority, Operator Copilot policy, owning domains, persistence, and composition remain separate.
- `backend/src/app/server/dependencies.ts`, `backend/src/app/server/types.ts`, `backend/src/app/http/openapi/openApiDocument.ts`, `packages/radioso-mcp-server/src/http/createHttpServer.ts`, and `frontend/components/dashboard/settings/api-access-panel.tsx` remain wiring/composition shells. New rules live in focused modules.
- `backend/src/app/composition/` wires the new authorization repository/service, Operator Copilot MCP adapter, internal proof verifier, and route mounts; it owns no product rule.
- Backend public HTTP changes originate from Zod schemas and OpenAPI path registration. Generated `backend/openapi.yaml`, `backend/openapi.json`, and TypeScript SDK snapshots are regenerated.
- Message-queue review: the admitted limited catalog contains no act and introduces no queue handoff or AMQP payload. `workspace_settings` reads; `retrieval_probe` executes synchronously under its existing provider budget; `propose_ingestion_settings` writes only a pending proposal. Existing queue payloads, document worker dispatch, retry contracts, queue tests, and queue docs are unchanged. Acts stay excluded until FR-038's owner review.
- Documentation updates include operator setup/security/deployment docs, MCP package docs, public docs portal, root quick-start/auth notes where relevant, local README ownership notes, and launch-client fixture records.

## Project Structure

### Documentation (this feature)

```text
specs/1148-operator-mcp-oauth/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── oauth-http.md
│   ├── operator-mcp.md
│   └── internal-capability.md
└── tasks.md
```

### Source Code

```text
backend/
├── src/modules/operatorMcpAuthorization/
│   ├── contracts.ts                 # grant/client/token/repository ports and Zod contracts
│   ├── domain.ts                    # scope, redirect, PKCE, lifetime, and safe presentation rules
│   ├── clientMetadataService.ts     # validated/pinned CIMD resolution
│   ├── authorizationService.ts      # authorize, consent, code exchange, refresh, revoke
│   ├── grantService.ts              # inventory/current grant and administrator revocation
│   ├── credentialValidationService.ts # bearer validation only
│   ├── proof.ts                     # internal proof/signature codec
│   ├── routes.ts                    # OAuth and session lifecycle transport only
│   ├── observability.ts             # fixed event/reason vocabulary
│   └── public.ts                    # narrow exports
├── src/modules/operatorMcpSetup/
│   ├── setupArtifacts.ts            # versioned launch-client definitions
│   └── public.ts
├── src/modules/operatorCopilot/
│   ├── contracts.ts                 # required MCP disposition and proposal-origin union
│   ├── mcpApplicationService.ts     # catalog, invoke, budget, reconciliation owner
│   ├── mcpRoutes.ts                 # service-authenticated admission/catalog/invoke
│   └── tools/shared.ts              # transport-neutral proposal origin helper
├── src/db/
│   ├── migrations/<next>_operator_mcp_oauth.sql
│   ├── repositories/operatorMcpAuthorizationRepository.ts
│   ├── repositories/operatorMcpInvocationRepository.ts
│   ├── repositories/operatorMcpRowMapper.ts
│   └── schema.sql                   # generated
├── src/shared/infra/kysely/schema.ts # generated
├── src/app/http/openapi/
│   ├── paths/operatorMcpPaths.ts
│   ├── openApiPaths.ts              # path registration owner
│   ├── openApiRegistry.ts           # schema catalog owner
│   └── openApiDocument.ts           # generated-document assembly
├── src/app/composition/operatorMcp.ts
└── tests/{unit,integration,contract}/operatorMcp/

packages/operator-mcp-contract/
├── src/index.ts                     # catalog/invoke DTOs and proof codec only
└── tests/

packages/radioso-mcp-server/
├── src/operator/
│   ├── backendAdapter.ts            # signed validation/catalog/invoke calls
│   ├── protectedResource.ts         # metadata and challenges
│   ├── requestHandler.ts            # stateless method dispatch
│   └── types.ts
├── src/http/createHttpServer.ts     # route mount only
├── src/config.ts                    # operator resource/internal-secret configuration
└── tests/operator*.test.ts

frontend/
├── app/oauth/operator-mcp/consent/page.tsx
├── components/dashboard/settings/operator-mcp-access-card.tsx
├── components/operator-mcp/operator-mcp-consent.tsx
├── lib/api-operator-mcp.ts
├── tests/unit/api-operator-mcp.test.ts
└── tests/e2e/operator-mcp-oauth.spec.ts

docs/operator-mcp.md
docs/architecture/code-map.md
docs-portal/content/guides/operator-mcp.mdx
```

**Structure Decision**: `operatorMcpAuthorization` owns inbound delegated authorization as a
new backend domain. Operator Copilot owns descriptor eligibility and invocation.
The narrow `operator-mcp-contract` package owns only cross-process DTOs and the
canonical internal proof envelope; it has no policy or persistence. The standalone package owns only MCP protocol and backend adaptation. Existing
agent MCP construction and tool definitions are not reused or modified except
for route-level sibling wiring. Dashboard concerns are split between an API
adapter, a settings card, and a dedicated consent surface.

## Module Ownership & Seams

- **Transport Layer**: Backend OAuth/session routes, Operator Copilot internal
  routes, and the standalone operator request handler parse/format protocol only. Frontend components
  render state and delegate all API operations to `api-operator-mcp.ts`.
- **Orchestration Layer**: `OperatorMcpAuthorizationService` coordinates client
  resolution, transaction persistence, consent, code exchange, refresh, and
  revoke. `OperatorMcpCredentialValidationService` resolves only current grant
  authority. `OperatorCopilotMcpApplicationService` owns descriptors, internal
  admission proofs, durable budget/idempotency, and direct execution.
- **Domain Layer**: Pure scope, resource, PKCE, redirect, token lifetime,
  metadata normalization, grant replacement, and refresh replay rules live in
  `operatorMcpAuthorization/domain.ts`. `operatorCopilot/mcpApplicationService.ts` owns generic
  descriptor mapping and tool invocation, not OAuth.
- **Persistence/Integration Layer**: Authorization declares only its client,
  transaction, grant, and credential repository port; Operator Copilot declares
  its invocation, budget, and reconciliation port. Separate Kysely adapters
  implement them. Metadata HTTP access depends on a
  narrow public-URL fetch port backed by existing DNS-pinned infrastructure.
  Raw tokens are hashed before repository calls.
- **Application Composition**: `backend/src/app/composition/operatorMcp.ts`
  constructs repository-backed authorization and Operator Copilot MCP services,
  the internal proof codec, current-access evaluator, and route dependencies.
  Server builders mount returned routes and
  expose dependencies without moving rules into composition.
- **Files Kept Small**: `server.ts` remains the existing one-agent server;
  `createHttpServer.ts` only routes `/mcp`, `/operator/mcp`, metadata, and health;
  `operatorCopilot/contracts.ts` contains shared types but no lifecycle logic;
  `copilotToolCatalog.ts` assembles only; `dependencies.ts` wires only;
  `api-access-panel.tsx` composes cards only; OpenAPI `openApiPaths.ts`
  registers path modules, `openApiRegistry.ts` owns schema registration, and
  `openApiDocument.ts` only assembles the generated document. AGENTS.md's
  historical `document.ts` example is stale relative to this tree.
- **Planned Extractions**: Required descriptor disposition, discriminated
  proposal origin, current operator authorization context, split authorization
  and invocation repositories, cross-process DTO/proof package, and machine-access lifecycle
  participation are the explicit new seams. Membership UUID remains the tenure;
  lifecycle revocation extends the existing atomic machine-access hook instead
  of adding a parallel listener.
- **Required Refactor Stories**: Proposal origin must become transport-neutral
  before the MCP proposal is enabled. No other prerequisite refactor is needed;
  the existing catalog, repository adapter convention, and sibling MCP route
  make ownership clear.

## Delivery Phases

### Phase 1 — Foundation and contracts

Add the shared DTO/proof contract and a minimal isolated operator transport that
passes the standard MCP `2026-07-28` stateless/no-initialize wire profile.
This phase does not claim MCP SDK or real-client conformance: the operator
dispatcher is deliberately isolated from the compatibility-protected agent SDK
runtime. Freeze the available Codex CLI 0.149.0 and Claude Code 2.1.149 build
identities in setup fixtures and exercise the internal profile against a local
fake authorization-server/resource journey. An exact
named-client discovery/callback transcript is still required before either
fixture is labeled verified; ChatGPT remains unverified until its hosted journey
is captured. Phase 1 ends green with unsupported clients explicitly unavailable.
No later phase may depend on a deliberately red protocol test.

### Phase 2 — Connect and current authority (US1, US3)

Implement discovery, CIMD/preregistered identity with immutable normalized
metadata versions bound through transaction and code, authorization transaction,
consent, code/refresh/revoke, authoritative grant intersection, internal proofs,
and stateless `tools/list`. Persist the exact scopes issued to every access or
refresh generation and always intersect them with the current grant. Verify
cross-instance revocation and credential-class isolation.

### Phase 3 — Complete browser consent, dashboard setup, and inventory (US1, US2, US5)

Implement public lifecycle contracts, client-specific setup artifacts owned by
`operatorMcpSetup`, the consent page after its backing authorization routes,
then its Playwright security journey, API Access card, authoritative grant
inventory/detail/revoke, and workspace-administrator views. Phase 2's backend
OAuth checkpoint is intentionally not the completion gate for visible US1.

### Phase 4 — Direct tools and proposal provenance (US4)

In Operator Copilot, implement durable per-grant cost reservations, operation
reconciliation, internal catalog/invoke routes, generic descriptor invocation,
bounded results, and the three-tool limited catalog. Make proposal and replay
evidence origin transport-neutral and add a conversation-independent
review route that reuses the existing proposal card.

### Phase 5 — Dark transport, compatibility, docs, and release gates (US6)

Add client fixtures, multi-instance tests, safe telemetry/audit, disabled and
degraded states, generated contracts/SDK, docs, and full regressions. If every
named fixture remains unverified, the transport is code-complete but dark; only
fixtures with captured exact-build journeys may enter limited rollout. Keep GA
off because no act is admitted.

## Security And Failure Model

- Authorization requests are rejected before redirecting unless client identity
  and redirect trust are established. Consent is session- and transaction-bound,
  requires the existing non-simple CSRF header, and inherits no-frame/no-referrer
  response headers.
- Metadata fetches cap 64 KiB, five seconds, and three redirects; validate HTTPS,
  public resolved addresses, and exact connect-time resolution for every hop.
  Normalized allowlisted fields become an immutable client-metadata snapshot;
  the transaction, authorization code, grant, and issued credentials bind its ID
  and digest.
- OAuth errors disclose no user/workspace existence. Revocation is idempotent.
  Credential comparison uses digests and timing-safe proof validation.
- Internal signatures have a 30-second skew/lifetime, exact method/path/body
  binding, and one-time invocation nonce persisted in PostgreSQL.
- Access/refresh rows persist their exact issued scope ceiling. Client status and
  version, grant version, issued scopes, membership tenure, and an externally
  monotonic deployment credential epoch are checked on every use. Startup may
  initialize or move persisted state to a higher configured epoch, but never
  auto-advances on key change; lower epochs or same-epoch fingerprint mismatches
  fail readiness. Rotation/restore explicitly raises the external epoch, and
  mixed epoch/key replicas cannot both serve.
- Operator feature dependency failure returns safe 503/JSON-RPC unavailable
  without affecting ordinary backend routes or `/mcp`.
- Tool arguments/results remain transient. Stateful reconciliation persists
  only an HMAC input digest and safe object reference.
- Tool catalogs are not cached in the initial release. Every list rebuilds the
  current eligible/authorized projection; only public discovery metadata may be
  cached with a bounded lifetime.

## Dynamic Client Registration Gate

Codex CLI 0.149.0 and Claude Code 2.1.149 are frozen with CIMD or exact
preregistration as their allowed paths. ChatGPT uses CIMD or predefined client
identity. No frozen row currently requires DCR, so the DCR endpoint is disabled
and not advertised. If a frozen-client proof shows DCR is required, delivery
stops and adds the bounded registration contract and tests from FR-016/FR-046
before that client can be labeled supported; there is no silent fallback or
anonymous DCR.

## Observability

- Counters: OAuth request outcomes, token grant type/outcome, grant lifecycle,
  operator MCP method/outcome, authorization-denial reason class, budget refusal,
  metadata dependency failure, and proof failure.
- Histograms: authorization decision, token exchange, catalog, and internal
  admission latency with fixed route/stage labels only.
- Audit: consent approval/denial, grant replacement/revocation, refresh replay,
  administrator revocation, and tool outcome. Fixed safe fields are event type,
  outcome/reason enum, request correlation ID, and opaque account/workspace/user/
  grant/client/invocation IDs, plus the reviewed descriptor identity, capability
  shape, and calling surface. Descriptor/shape/surface are audit fields, never
  metric labels. Audit never includes raw metadata, scopes, arguments, results,
  or credentials. Source and principal flood controls bound rejected-event volume.
- Traces: standalone admission/catalog/invoke correlation with generated IDs;
  no token, client metadata body, scopes, descriptor arguments/results, prompts,
  or customer content.

## API, SDK, Queue, And Documentation Impact

- Code-first OpenAPI: add dashboard inventory/detail/revoke and consent-transaction
  JSON contracts in `operatorMcpPaths.ts`, register paths/schemas through
  `openApiPaths.ts` and `openApiRegistry.ts`, then run
  `cd backend && pnpm run generate:openapi`.
- Generated clients: run `pnpm --dir typescript-sdk run sync`,
  `pnpm --dir packages/radioso-mcp-server run sync:openapi`, and root
  `pnpm run check:api-contracts`, then build and test both consumers. The MCP
  package currently lacks its documented sync script, so restoring that drift
  guard is part of this change.
- MCP package contract: version the operator resource constants/types/tests in
  `@radioso/operator-mcp-contract` and consume it from the backend and
  `@radioso/mcp-server`; existing agent contract stays intact.
- Queue review: no worker/AMQP change for the admitted descriptors. Record this
  result in docs/PR; do not alter queue code or documentation.
- Docs: read `docs/document-writer-prompt.md` before changes; update root setup,
  MCP package README, operator guide, docs portal, code map/local briefs, and
  environment examples.

## Post-Design Constitution Recheck

PASS. Research resolved all design choices needed to implement the approved
limited rollout. There are no `NEEDS CLARIFICATION` items and no constitution
exceptions. The planned file count is justified by four independent deployable
boundaries (backend domain, persistence, standalone protocol, frontend) and by
keeping lifecycle, transport, catalog, and UI concerns out of existing god files.

## Complexity Tracking

No constitution violations require justification.
