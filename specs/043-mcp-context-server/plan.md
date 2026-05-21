# Implementation Plan: Remote MCP Context Server

**Branch**: `borohhov/mcp-control-plane` | **Date**: 2026-04-22 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/milan/specs/043-mcp-context-server/spec.md)
**Input**: Feature specification from `/specs/043-mcp-context-server/spec.md`

> **Amendment 2026-05-19**: The "approvals" control-plane foundation described in this plan has been removed. The shared store now only holds session state; the workspace policy still exposes `approvalRequiredWriteTools`, but that field drives the `requiresApproval: true` tool-list annotation rather than a server-side approval-token gate. The MCP host prompts the user.

## Summary

Evolve the existing standalone MCP package into a more hostable remote product surface. The package will keep owning the Streamable HTTP server, token exchange, approvals, and audit logging, but this iteration adds three control-plane foundations: a shared-store mode for sessions and approvals, workspace-aware policy overrides, and an explicit backend capability/context contract so tool exposure is negotiated instead of guessed. The package remains inside the monorepo for now, but its server-owned concerns will stay behind package-local interfaces and directories so extraction to a separate repository is mechanical rather than architectural.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 24
**Primary Dependencies**: `@modelcontextprotocol/server`, Zod v4, Vitest, tsx, Node built-ins (`crypto`, `fs`, `http`), a Redis client for optional shared-store mode
**Storage**: Existing Radioso PostgreSQL state remains behind HTTP APIs; package-owned MCP session and approval state must support both in-memory local mode and shared-store mode for multi-instance hosting
**Testing**: Vitest backend and package tests for the new backend context contract, workspace-aware policy resolution, shared-store session/approval behavior, and stateless remote HTTP transport; remote JSON-RPC smoke validation across at least two server instances when shared store is enabled
**Target Platform**: Node.js 24 on macOS/Linux/Windows-compatible server environments
**Project Type**: Monorepo web application with an extractable standalone package-owned server
**Performance Goals**: Exchange and policy checks add negligible overhead relative to upstream Radioso calls; remote tool execution should add no more than one extra in-process policy/auth check and zero extra upstream round-trips beyond what each tool requires
**Constraints**: No code-level mutual dependencies between backend app modules and MCP server code; no direct database access from the MCP package; backend TDD remains mandatory; secrets stay in env/config only; package-local state must remain replaceable; sticky-session-only deployment is not an acceptable end state for this slice
**Scale/Scope**: Multi-instance-ready remote runtime for one deployment, short-lived access tokens, approval-gated write tools, shared-store support, and a small high-value tool catalog for one workspace per exchanged session

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`.
- LLM provider remains GPT-5.2 for grounded-answer integrations.
- Secrets and signing material are managed via `.env` and `.env.example` is updated if configuration changes.
- Customer data handling and auditability are addressed through workspace-scoped upstream tokens, package-issued MCP access tokens, approval gates, structured audit logs, and explicit workspace identity/capability introspection.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit and preserve extractability.
- Existing responsibility-limited files are identified, and the plan avoids turning backend route files or the SDK entrypoint into protocol-specific god modules.
- Backend HTTP contracts are reused rather than replaced, except for one additive code-first context endpoint that strengthens package/backend negotiation without embedding MCP in the backend.
- Docs updates are included for the new remote startup, auth exchange, shared-store configuration, workspace policy overrides, and governed write flow.

## Project Structure

### Documentation (this feature)

```text
specs/043-mcp-context-server/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── mcp-tool-catalog.md
│   └── remote-http.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/
└── radioso-mcp-server/
    ├── src/
    │   ├── audit/
    │   ├── auth/
    │   ├── cli/
    │   ├── http/
    │   ├── policy/
    │   ├── state/
    │   ├── tools/
    │   ├── transport/
    │   ├── config.ts
    │   ├── errors.ts
    │   ├── radiosoApiAdapter.ts
    │   ├── server.ts
    │   ├── toolResult.ts
    │   └── types.ts
    ├── tests/
    ├── package.json
    ├── tsconfig.json
    └── tsconfig.build.json

backend/
├── src/app/http/routes/
├── src/app/http/openapi/
└── tests/
```

**Structure Decision**: All remote-server concerns continue to live under `packages/radioso-mcp-server/`. The package will own its HTTP server, auth exchange, approval issuance, shared-store adapters, workspace policy resolution, audit sinks, and MCP transport wiring. The backend remains the upstream system of record, but gains one thin authenticated context endpoint that publishes workspace identity plus MCP-relevant capability/version metadata. This preserves monorepo ergonomics now while making extraction straightforward later.

## Module Ownership & Seams

- **Transport Layer**: `src/http/*` and `src/transport/*` own HTTP routing, request/response adaptation, and MCP transport lifecycle only.
- **Auth Layer**: `src/auth/*` owns exchange validation, access-session creation, approval issuance, access-token parsing, and store abstractions.
- **Policy Layer**: `src/policy/*` owns tool allowlists, workspace policy overrides, approval requirements, and granted capability selection.
- **State Layer**: `src/state/*` owns in-memory and shared-store adapters for access sessions and approval grants.
- **Audit Layer**: `src/audit/*` owns structured event contracts and sink implementations such as console and JSONL file output.
- **Orchestration Layer**: `src/server.ts` and `src/tools/*` coordinate tool registration, auth/policy hooks, and request handling without embedding Radioso business rules.
- **Integration Layer**: `src/radiosoApiAdapter.ts` owns all calls into the Radioso HTTP boundary, including the new authenticated workspace context probe.
- **Backend Contract Layer**: `backend/src/app/http/routes/*` stays backend-route-only, but may add one thin MCP context route; `backend/src/app/http/openapi/document.ts` stays the code-first contract registry and must carry any new backend route shape.
- **Files Kept Small**: `packages/radioso-mcp-server/src/server.ts` should remain wiring-focused, not become a policy/store dump; `packages/radioso-mcp-server/src/http/mcpRoutes.ts` should not absorb store or upstream-introspection logic.
- **Planned Extractions**: package-local auth services, workspace policy resolution, store adapters, audit sinks, remote HTTP handlers, and tool catalog.
- **Required Refactor Stories**: Remove process-local assumptions from remote request handling before introducing shared-store behavior.

## Phase 0 Research Decisions

- Use official Streamable HTTP transport for the remote MCP endpoint instead of inventing a custom RPC layer.
- Keep MCP-facing auth separate from upstream Radioso workspace tokens by exchanging for short-lived package-issued access tokens.
- Use package-owned capability profiles and explicit write approvals rather than exposing raw write tools whenever the upstream token permits them.
- Add a thin backend workspace-context endpoint so the package can negotiate workspace identity, version, and upstream capability support through a stable contract instead of inferring everything from downstream tool failures.
- Add shared-store support for sessions and approvals now rather than deferring multi-instance hosting to a vague later refactor.
- Move the remote request path toward stateless per-request server handling so shared-store mode is actually useful across instances.
- Emit structured audit events from the package itself rather than assuming the backend can explain MCP-specific denials and approvals.

## Complexity Tracking

No constitution violations are planned.
