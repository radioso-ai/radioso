# Implementation Plan: MCP Server Deployment Modes

**Branch**: `implement-spec-061` | **Date**: 2026-05-15 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/061-mcp-deployment-modes/spec.md`

## Summary

Add a shared MCP request-handler factory to `packages/radioso-mcp-server`, keep the standalone HTTP server as a thin adapter, and mount the same handler in the backend when `RADIOSO_MCP_ENABLED=true` and `RADIOSO_MCP_STANDALONE=false`. The merged verifier accepts workspace API tokens directly; standalone mode keeps the existing exchange flow. The dashboard and docs explain same-host versus remote setup.

## Technical Context

**Language/Version**: TypeScript on Node.js 24; React 19 / Next.js 16 for dashboard changes
**Primary Dependencies**: Express, `@modelcontextprotocol/server`, Zod, existing MCP package internals
**Storage**: Existing PostgreSQL backend state plus existing MCP in-memory/Redis runtime stores; no new persistence
**Testing**: Vitest, Supertest, existing MCP smoke suites, focused frontend unit tests for non-visual mode detection
**Target Platform**: Self-hosted Node backend and standalone MCP HTTP package
**Project Type**: Monorepo web app with backend, frontend, packages
**Performance Goals**: No new persistence calls beyond direct workspace token verification per merged request
**Constraints**: `/mcp` stays outside `/api/v1`; CORS for MCP is separate from cookie CORS; no new backend runtime dependency except the workspace MCP package
**Scale/Scope**: One backend mount path, existing standalone process, one dashboard channel card

## Constitution Check

- Spec exists and is approved by the implementation request; status is updated in `spec.md`.
- Backend work includes Vitest/Supertest tests before implementation for config, request handler parity, and merged mount behavior.
- Frontend behavior is limited to deterministic mode/snippet selection; unit tests are acceptable because no layout assertions are needed.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`; no new persistence layer.
- LLM provider behavior is unchanged.
- Secrets remain in env vars; `.env.example` will be updated for `RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE`, mount path, and merged CORS.
- Customer data handling uses existing workspace API token auth and MCP audit paths.
- Module boundaries are explicit: package owns MCP protocol/domain; backend owns runtime mount wiring.
- `backend/src/app/server/createApp.ts` remains an adapter mount point and does not own MCP product rules.
- Backend app composition is evaluated: default runtime wiring is in backend server/config modules; no application module extension is needed for the built-in mount.
- Backend HTTP OpenAPI does not change because `/mcp` is a peer transport and health additions use existing `/health`.
- Message queue impact: no document worker dispatch, AMQP payload, retry, queue test, or queue documentation changes are required.
- Docs updated in `.env.example`, `readme.md`, `docs/mcp-client-setup.md`, and package README.

## Project Structure

```text
packages/radioso-mcp-server/
├── src/http/requestHandler.ts       # shared framework-agnostic handler
├── src/http/expressAdapter.ts        # Express-compatible helper
├── src/http/createHttpServer.ts      # standalone adapter remains thin
├── src/http/runtime.ts               # standalone runtime wiring
└── tests/

backend/
├── src/app/config/env.ts             # MCP enable/standalone flags and mount config
├── src/app/server/createApp.ts       # merged mount before API router
├── src/app/server/mcpMount.ts        # backend MCP wiring and verifier
└── tests/

frontend/
├── components/dashboard/settings/mcp-channel-card.tsx
└── tests/unit/

docs/
└── mcp-client-setup.md
```

**Structure Decision**: The MCP package exports the protocol handler. Backend code consumes it as a workspace library and supplies backend-specific workspace-token verification. Frontend code only renders connection guidance.

## Module Ownership & Seams

- **Transport Layer**: `packages/radioso-mcp-server/src/http/requestHandler.ts`, `expressAdapter.ts`, and backend `mcpMount.ts`.
- **Orchestration Layer**: MCP auth/session/policy services in the package; backend mount builder assembles dependencies only.
- **Domain Layer**: Existing MCP tool catalog, capability policy, approval rules, and audit semantics.
- **Persistence/Integration Layer**: Existing backend auth/workspace repositories and existing MCP runtime stores.
- **Application Composition**: Backend built-in mount wiring belongs in `backend/src/app/server/mcpMount.ts`; no product rules move into composition.
- **Files Kept Small**: `backend/src/app/server/createApp.ts`, `packages/radioso-mcp-server/src/http/createHttpServer.ts`, and dashboard settings card.
- **Planned Extractions**: Shared MCP request handler, token verifier interfaces, merged backend verifier, frontend mode helper.
- **Required Refactor Stories**: Extract request handling from `mcpRoutes.ts` before adding backend mount.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |
