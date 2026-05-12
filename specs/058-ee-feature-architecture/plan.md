# Implementation Plan: Enterprise Feature Architecture Boundaries

**Branch**: `study-posthog-ee-structure` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/058-ee-feature-architecture/spec.md`

## Summary

Refactor Radioso's Enterprise Edition structure so existing Enterprise capabilities are represented by focused feature modules and lightweight manifests, then add validation that protects the OSS/EE boundary and module public-contract expectations. The implementation will preserve current Enterprise behavior while making ownership, generated frontend route stubs, and import boundaries explicit and testable.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 for backend/packages/scripts, React 19 and Next.js 16 for frontend packages
**Primary Dependencies**: Existing Express application module system, Vitest, npm workspaces, local Node scripts
**Storage**: PostgreSQL remains unchanged; no schema or data migration changes
**Testing**: Vitest for backend, Enterprise package, and script validation; existing build scripts for backend, frontend, and EE packages
**Target Platform**: Self-hosted Node/Next application, local OSS and Enterprise development flows, containerized deployment flows
**Project Type**: Web application with backend, frontend, Enterprise packages, and TypeScript package scripts
**Performance Goals**: Boundary and manifest validation should complete in under 5 seconds locally for normal development checks
**Constraints**: OSS run path must not require Enterprise packages; generated frontend route files must remain removable; no user-facing behavior changes
**Scale/Scope**: Existing Enterprise features only: usage limits, auth, human contact, website crawler, website embed, password reset/verification frontend pages, and embed widget frontend pages

## Constitution Check

- Spec exists and is approved; implementation is allowed after requester approval on 2026-05-07.
- Backend work includes TDD with tests written before implementation.
- Frontend user-visible behavior is not changing; frontend tests are limited to route generation logic.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`; no DB changes are planned.
- No LLM integration or prompt changes are planned.
- No new secrets are introduced; `.env.example` is not expected to change.
- Customer data handling is unaffected; validation errors must not expose secrets.
- Module boundaries are explicit: EE feature modules own EE registration, OSS composition remains generic, public contracts are the cross-module import surface, scripts own generation.
- Responsibility-limited files: `ee/packages/backend-module/src/index.ts`, `backend/src/app/composition/*`, `frontend/lib/edition-controller.ts`, `frontend/lib/api.ts`, and `scripts/sync-ee-frontend-routes.mjs`.
- Current structure is clear enough for an incremental refactor; no broad rewrite is required.
- Backend composition is in scope only for compatibility tests and public contract re-export surfaces; no feature-specific hooks will be added.
- Backend HTTP contracts do not change; `backend/src/app/http/openapi/document.ts`, `backend/openapi.yaml`, and `backend/openapi.json` are not in scope.
- Message-queue impact review: no worker dispatch payloads, AMQP queue payloads, retry semantics, queue tests, or queue docs change because this feature changes architecture boundaries and local route generation only.
- Documentation updates are required in `ee/readme.md`, `readme.md` where run-flow wording references route generation, and/or docs portal operator docs if the public run flow wording changes.

## Project Structure

### Documentation (this feature)

```text
specs/058-ee-feature-architecture/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
└── tasks.md
```

### Source Code

```text
backend/
├── src/modules/*/contracts/        # public contract surfaces for representative cross-module dependencies
├── src/app/composition/            # generic application module contracts and tests only
└── tests/unit/                     # boundary and public contract validation tests

ee/
├── package.json
├── readme.md
└── packages/
    ├── backend-module/src/
    │   ├── featureManifest.ts      # manifest contract and validation helpers
    │   ├── features/               # aggregate EE feature manifest registry
    │   ├── usageLimits/            # feature module and manifest
    │   ├── mail/                   # feature module and manifest
    │   ├── humanContact/           # feature module and manifest
    │   ├── websiteCrawler/         # feature module and manifest
    │   └── websiteEmbedIntegration.ts
    ├── auth-frontend/src/
    │   └── featureManifest.ts
    └── embed-widget/src/
        └── featureManifest.ts

scripts/
├── sync-ee-frontend-routes.mjs     # manifest-driven generated route stubs
└── validate-architecture-boundaries.mjs

tests/
└── unit or script-adjacent tests through existing Vitest projects
```

**Structure Decision**: Keep Radioso's current monorepo layout. Add small contract and manifest files next to owning features instead of moving product code into a new top-level `products/` tree. Route stub generation remains a root script because it writes into `frontend/app`, but its source of truth moves to Enterprise feature manifests.

## Module Ownership & Seams

- **Transport Layer**: Existing Express route files under `ee/packages/backend-module/src/*/*Routes.ts` and generated Next route stubs translate requests and exports only.
- **Orchestration Layer**: Existing EE services continue to coordinate feature workflows. New feature module files only register existing services, routes, migrators, hooks, and lifecycle.
- **Domain Layer**: Existing feature-specific service/config/provider files remain the home for feature rules. New manifest validation logic owns manifest schema rules only.
- **Persistence/Integration Layer**: Existing DB migrators and document ingestion dependencies remain unchanged.
- **Application Composition**: `backend/src/app/composition/` remains generic. It may expose public types through contract barrels, but it must not gain Enterprise-specific hooks.
- **Files Kept Small**: `ee/packages/backend-module/src/index.ts` becomes aggregation-only; `scripts/sync-ee-frontend-routes.mjs` delegates route ownership to manifests; `frontend/lib/edition-controller.ts` remains runtime gating only; `frontend/lib/api.ts` remains API client only.
- **Planned Extractions**: Per-feature EE `applicationModule.ts` files, feature manifests, boundary validation script, representative public contract barrels for chat/documents/app composition, and route manifest synchronization helpers.
- **Required Refactor Stories**: US1 must land before the manifest and route generation stories because manifests need stable feature IDs and module ownership.

## Complexity Tracking

No constitution violations are expected.
