# Implementation Plan: Ray Capability and Authorization Boundary

**Branch**: `evaluate-issue-1105` | **Date**: 2026-08-28 | **Spec**: [spec.md](./spec.md)
**Input**: Approved capability-boundary specification for Ray (issue #1105).

## Summary

Make Ray a least-privilege projection of the existing workspace authorization model. The Operator Copilot module will own typed descriptor provenance and current-permission gates around every protected descriptor hook and proposal flow. Owning application modules will expose or reuse narrow reads; composition will only wire implementations. Governance tests will validate both forward public-operation coverage and reverse descriptor provenance/permission parity. Complete the eval OpenAPI registry and regenerate all published contract snapshots.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24
**Primary Dependencies**: Express, Zod, OpenAI SDK, Vitest, Supertest
**Storage**: Existing PostgreSQL 16/pgvector; no migration or schema change planned
**Testing**: Vitest unit/contract/integration tests; deterministic Ray eval suite; generated-contract checks
**Target Platform**: Self-hosted Node.js backend and TypeScript SDK/MCP packages
**Project Type**: Backend service with generated SDK and standalone MCP package
**Performance Goals**: Preserve existing descriptor/proposal latency; authorization checks use existing workspace permission resolution
**Constraints**: No Ray-specific granting roles, policy UI, schema, direct repository reads, prompt/content-bearing authorization diagnostics, or public proposal-safety contract
**Scale/Scope**: Every assembled production Ray descriptor, every supported workspace role, all applicable individual permission revocation/grant vectors, all live operator eval routes

## Constitution Check

- [x] The approved `spec.md` exists before implementation.
- [x] Backend behavior and governance work is planned red-green-refactor, with tests observed failing before the corresponding implementation.
- [x] Stack, storage, and AI-provider choices are unchanged; no configuration or secret changes are needed.
- [x] Current workspace roles stay the sole positive authority. Current permission reads and safe, content-free audit/telemetry cover the new authorization boundary.
- [x] Operator Copilot owns catalog policy, bounded projections, Ray-owned proposals, and orchestration; owner modules retain reads, mutations, lifecycle rules, and persistence.
- [x] `backend/src/app/composition/` is required only for wiring the provenanced catalog and narrow ports; it must not retain proposal or authorization policy.
- [x] OpenAPI changes originate in code-first registry files; `backend/openapi.yaml` and `backend/openapi.json` are regenerated outputs. SDK and MCP snapshots will be regenerated together.
- [x] Queue impact review: this changes neither document-worker dispatch nor AMQP payloads, retries, queue semantics, queue tests, or queue documentation.
- [x] Durable architecture documentation and relevant operator/API docs are in scope; no frontend behavior or hard-coded assistant copy is introduced.

## Project Structure

```text
backend/
├── src/modules/operatorCopilot/       # descriptor provenance, current-auth hooks, proposals, governed catalog
├── src/modules/{chat,documents,routines,embeddingProfiles,eval}/
│   └── public.ts/contracts/services/  # narrow owner-module ports and eval route behavior
├── src/app/composition/               # construction-only catalog/port wiring
├── src/app/http/{routes,openapi}/     # eval route registration and code-first operation identities
├── tests/unit/operatorCopilot/        # red-green descriptor/governance/authorization tests
├── tests/{contract,integration}/      # public eval and permission parity coverage
└── scripts/generateOpenApi.ts
typescript-sdk/{openapi,src/generated}/ # generated API snapshot
packages/radioso-mcp-server/            # generated or verified API contract snapshot
docs/architecture/ and docs-portal/     # durable boundary/operator documentation
specs/1105-ray-capability-boundary/     # plan, tasks, queue impact record
```

## Module Ownership & Seams

- **Transport Layer**: `operatorCopilot/routes.ts`, eval routes, and OpenAPI path registration translate requests and state operation identities/authorization; they do not decide domain eligibility.
- **Orchestration Layer**: `operatorCopilot/catalog.ts`, `service.ts`, tool descriptors, and proposal services own Ray safe projections, provenance declarations, current-authorization sequencing, and Ray-only dispositions.
- **Domain Layer**: Chat exposes conversation identity; documents expose shared source summaries; routines retain validation/mutation; embedding profiles reuse their coverage boundary; eval retains case and execution behavior.
- **Persistence/Integration Layer**: Existing repositories remain behind owner-module ports. Operator Copilot must not gain direct dependencies on conversation, routine, document-source, or embedding repositories.
- **Application Composition**: `copilotToolCatalog.ts` and its adjacent builders supply concrete ports/registry defaults only. Move existing policy out first if discovery finds it embedded there, particularly routine proposal work.
- **Files Kept Small**: `copilotToolCatalog.ts` stays a factory; `copilotProposalAdapters.ts` stays construction/adaptation only; descriptor-specific behavior remains under `operatorCopilot/tools/` and owner ports under their modules.
- **Planned Extractions**: A typed provenance/permission registry, a current-entitlement authorization gate usable at catalog assembly and every protected hook, and machine-readable owner-module primitive identities.
- **Required Refactor Stories**: Extract any direct repository-backed Ray reads to narrow public ports before applying fresh authorization around them; extract routine proposal policy from composition if it cannot remain a pure adapter.

## Delivery Decisions

1. Model descriptor provenance as a discriminated declaration: backing public operation identities and/or registered application primitives, plus optional Ray-only disposition with non-empty reviewed reason. Entirely Ray-only descriptors use the disposition without fabricated primitives.
2. Resolve descriptor permissions from the existing authorization authority at catalog assembly and immediately before each protected descriptor-owned read/effect. The gate must be invoked before entity resolution, label/handoff enrichment, preflight reads, proposal creation, execution, and proposal application.
3. Treat composed reads as all-of unless the tool intentionally returns per-source results; preserve `unauthorized` separately from empty/error in the latter case.
4. Validate governance from the real assembled production catalog: descriptor identity, no duplicates/conflicts, primitive registry validity, generated OpenAPI operation validity, forward coverage, one-to-one parity, explicit dispositions, and exhaustive role/permission-vector authorization behavior.
5. Keep optimistic proposal guards documented as Ray-only safety. Application still reauthorizes and delegates mutations to the owning service.

## Validation Strategy

- Red/green focused Vitest tests for each introduced authorization/provenance/owner-port behavior, retaining the failing test evidence in task execution notes.
- Run the Operator Copilot unit suite, permissions/eval route contract tests, architecture boundary lint, deterministic copilot eval suite, OpenAPI generation/contract checks, SDK and MCP builds/tests, then applicable `pnpm run ci:local -- origin/main` before PR readiness.
- Inspect denial audit/telemetry test fixtures for absence of sensitive prompt or tool content. No new metrics are needed for static checks; runtime denials reuse existing content-free audit conventions.

## Complexity Tracking

No constitution violations or unjustified complexity are planned.
