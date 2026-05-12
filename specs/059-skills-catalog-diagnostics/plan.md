# Implementation Plan: Skills Catalog Diagnostics

**Branch**: `059-skills-catalog-diagnostics` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/059-skills-catalog-diagnostics/spec.md`

## Summary

Add a read-only Radioso skills catalog and shared diagnostic definitions without adding generic skill execution. The implementation introduces a focused backend skills module that owns catalog metadata and diagnostic schemas, wires a default catalog through application composition, exposes authenticated read-only HTTP routes, updates code-first OpenAPI and generated SDK types, and documents how skills relate to capabilities, intents, strategies, agents, MCP, SDK, and current public contracts.

## Technical Context

**Language/Version**: TypeScript on Node.js 24
**Primary Dependencies**: Express, Zod, zod-to-openapi, Vitest, Supertest  
**Storage**: N/A; catalog metadata is static/default composition metadata for this feature  
**Testing**: Vitest unit and contract tests; generated OpenAPI contract verification  
**Target Platform**: Backend HTTP API, TypeScript SDK contract generation, MCP/SDK documentation  
**Project Type**: Web application with backend API, SDK package, MCP package, and docs  
**Performance Goals**: Catalog list and detail responses remain lightweight static metadata reads with no database or LLM calls  
**Constraints**: No generic skill execution; no retrieval ranking changes; no assistant routing changes; no new storage; no runtime prompt assets; no frontend UI in this feature  
**Scale/Scope**: One backend skills module, two read-only API operations, shared catalog and diagnostic schemas, SDK type regeneration, MCP/SDK/docs updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved by the user-provided delivery instruction to proceed on the accepted scope; no implementation outside the spec.
- Backend work includes TDD with failing tests written before implementation.
- No frontend user-visible behavior is in scope, so Playwright coverage is N/A.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`; no schema or storage changes are planned.
- No new LLM integration is introduced; GPT-5.2 default provider remains unchanged.
- No secrets or new configuration are introduced; `.env.example` is not affected.
- Customer data handling is minimal because catalog metadata is static and contains no customer document content.
- Module boundaries are explicit: routes adapt HTTP, the skills module owns catalog and diagnostic definitions, composition wires defaults, existing product modules keep execution behavior.
- Existing responsibility-limited files are identified below; route handlers and OpenAPI registry are updated only for transport/contract declaration.
- Current structure is clear enough for a focused module; no prerequisite refactor story is required.
- Backend work adds an app-wide catalog registry/default, so `backend/src/app/composition/` must be evaluated and own default wiring.
- Backend HTTP contracts change, so `backend/src/app/http/openapi/document.ts` must be updated and generated `backend/openapi.yaml` / `backend/openapi.json` must be regenerated.
- Public API, SDK, and MCP-facing contract descriptions change. Message-queue impact review: no document worker dispatch, AMQP payload, retry semantic, queue test, or queue documentation changes are required because the catalog is read-only metadata and does not enqueue work.
- Docs to update: `docs/radioso-skills-rfc.md`, `docs/README.md`, SDK usage docs, and MCP setup/docs where skill discovery is mentioned.

## Project Structure

### Documentation (this feature)

```text
specs/059-skills-catalog-diagnostics/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── skills-catalog.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── composition/
│   │   ├── http/
│   │   │   ├── openapi/
│   │   │   └── routes/
│   │   └── server/
│   ├── modules/
│   │   └── skills/
│   └── shared/domain/
├── tests/
│   ├── contract/
│   └── unit/
├── openapi.yaml
└── openapi.json

typescript-sdk/
└── src/generated/

docs/
```

**Structure Decision**: Add a focused `backend/src/modules/skills/` module for catalog and diagnostic domain types. Wire the default catalog through `backend/src/app/composition/` and expose it through `AppDependencies`. Add `backend/src/app/http/routes/skillRoutes.ts` for transport. Register schemas and routes in the code-first OpenAPI document.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/skillRoutes.ts` translates authenticated read-only requests and delegates to the skills service.
- **Orchestration Layer**: A skills catalog service in `backend/src/modules/skills/` assembles caller-visible catalog metadata from registered entries and capability policy decisions.
- **Domain Layer**: `backend/src/modules/skills/` owns skill names, catalog entry types, availability states, execution class values, caller surface values, diagnostic definitions, and default built-in entries.
- **Persistence/Integration Layer**: N/A for this feature; no database or external service calls are required.
- **Application Composition**: `backend/src/app/composition/` owns default skill catalog registration and optional future extension points. Composition assembles metadata only; it must not own skill product rules.
- **Files Kept Small**: `backend/src/app/http/routes/index.ts` only mounts the route. `backend/src/app/http/openapi/document.ts` only declares the API contract. Assistant and retrieval services do not absorb catalog ownership. MCP tool files do not invent a separate vocabulary.
- **Planned Extractions**: New skills module public surface, catalog service, default catalog builder, diagnostic schema/type definitions, and optional composition registration seam for future modules.
- **Required Refactor Stories**: None.

## Complexity Tracking

No constitution violations require justification.

## Phase 0 Research

See [research.md](./research.md).

## Phase 1 Design

See [data-model.md](./data-model.md), [contracts/skills-catalog.md](./contracts/skills-catalog.md), and [quickstart.md](./quickstart.md).

## Agent Context Update

The standard Speckit context update script was intentionally not run. It targets `AGENTS.md` for Codex, and this repository's `AGENTS.md` maintenance rules say the file is hand-maintained and must not receive generated inventories, recent-change notes, or feature-specific scratch notes. The durable skills direction is documented in `docs/radioso-skills-rfc.md` instead.

## Post-Design Constitution Check

- Backend TDD remains required and is reflected in tasks.
- Public API contract work is scoped to code-first OpenAPI plus generated artifacts.
- Message-queue impact is documented as no impact.
- Documentation parity is included in tasks.
- Module boundaries remain explicit, with the skills module owning catalog/diagnostic definitions and composition owning default wiring.
