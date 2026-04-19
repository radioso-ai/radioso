# Implementation Plan: MCP Context Server

**Branch**: `043-mcp-context-server` | **Date**: 2026-04-19 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/milan/specs/043-mcp-context-server/spec.md)
**Input**: Feature specification from `/specs/043-mcp-context-server/spec.md`

## Summary

Deliver a standalone Radioso MCP server as a new package that exposes workspace-scoped read and write tools while keeping protocol concerns out of the existing backend. The server will use the Radioso HTTP contract through a focused API adapter rather than importing backend domain modules, and it will ship with backend-first tests, package-level tests, and operator docs for setup and usage.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22  
**Primary Dependencies**: `@modelcontextprotocol/server`, Zod v4, first-party Radioso HTTP/SDK client adapter, Vitest, tsx  
**Storage**: No new persistence; existing Radioso PostgreSQL state accessed only through existing HTTP APIs  
**Testing**: Vitest package-level unit tests, targeted SDK contract smoke tests, existing backend tests remain green  
**Target Platform**: Local stdio MCP clients on macOS/Linux/Windows-compatible Node.js 22  
**Project Type**: Web application plus standalone local package  
**Performance Goals**: Tool overhead should stay negligible versus the underlying Radioso API calls; covered tool calls should complete without extra round trips beyond required Radioso reads/writes  
**Constraints**: No code-level mutual dependencies between backend app modules and MCP transport code; no direct database access from the MCP package; backend TDD remains mandatory; secrets must stay in env/config only  
**Scale/Scope**: Initial release exposes a small, high-value tool catalog for grounded reads and document-oriented writes for a single authenticated workspace session

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated if configuration changes.
- Customer data handling and auditability are addressed through workspace-scoped credential usage and least-privilege tool behavior.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects.
- Backend HTTP contracts are reused rather than replaced; no hand-edited OpenAPI artifacts are planned unless an additive contract gap is discovered.
- Docs updates are included for the new standalone package and operator setup flow.

## Project Structure

### Documentation (this feature)

```text
specs/043-mcp-context-server/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── mcp-tool-catalog.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/app/http/openapi/
├── src/app/http/routes/
└── tests/

typescript-sdk/
├── src/
└── tests/

packages/
├── connector-api/
├── document-parser/
└── radioso-mcp-server/
    ├── src/
    │   ├── cli/
    │   ├── tools/
    │   └── transport/
    ├── tests/
    ├── package.json
    ├── tsconfig.json
    └── tsconfig.build.json
```

**Structure Decision**: The MCP surface will live in `packages/radioso-mcp-server/` as a standalone package with its own runtime entrypoint and tests. The existing backend continues to own business behavior behind HTTP routes, while the MCP package owns only protocol registration and translation into a focused Radioso API adapter. The TypeScript SDK may be reused or lightly extended as a stable client boundary; the backend must not import anything from the MCP package.

## Module Ownership & Seams

- **Transport Layer**: `packages/radioso-mcp-server/src/cli/*` and `src/transport/*` own MCP server startup, stdio transport wiring, and process lifecycle only.
- **Orchestration Layer**: `packages/radioso-mcp-server/src/server.ts` and `src/tools/*` coordinate tool registration and request handling without embedding Radioso business rules.
- **Domain Layer**: Focused tool modules define capability names, validated inputs, and output shaping for read/write operations.
- **Persistence/Integration Layer**: `packages/radioso-mcp-server/src/radiosoApiAdapter.ts` owns all calls into the Radioso HTTP/SDK boundary.
- **Files Kept Small**: `backend/src/app/http/routes/*` stay backend-route-only; `backend/src/app/http/openapi/document.ts` stays contract registry only; `typescript-sdk/src/index.ts` stays a thin client surface.
- **Planned Extractions**: New package-local tool catalog, result formatter, environment config loader, and Radioso API adapter.
- **Required Refactor Stories**: None expected if the package boundary is preserved. If a missing SDK/client seam blocks the package, add a focused SDK extraction before continuing.

## Complexity Tracking

No constitution violations are planned.
