# Implementation Plan: Confirmed Operator MCP Authoring

**Branch**: `1150-operator-mcp-authoring` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Approved confirmed-authoring workflow for Operator MCP.

**Note**: This template is filled in by the `$speckit-plan` command; its definition describes the execution workflow.

## Summary

Expose bounded routine drafting, existing per-agent retrieval configuration, and
agent publication through the existing stateless Operator MCP transport. A client
prepares an immutable reviewed artifact, presents it in conversation, and calls a
write-scoped execution tool only after it has obtained conversational confirmation.
The server verifies the grant, principal/client binding, digest, target fences and
idempotency; it does not claim to independently attest human presence.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript on Node.js 24; React 19 / Next.js 16 only for any necessary visible regression coverage

**Primary Dependencies**: Express, Zod, Kysely/PostgreSQL, `@modelcontextprotocol/server`, existing `@radioso/operator-mcp-contract`

**Storage**: PostgreSQL for existing Operator MCP grants/invocations and new reviewed-operation/candidate state; existing agent/routine/revision settings stores remain authoritative

**Testing**: Vitest unit/contract/integration, MCP fake-journey tests, package smoke tests, fresh-build Playwright only when a browser surface is added or changed

**Target Platform**: self-hosted backend and standalone MCP HTTP service

**Project Type**: pnpm web-application monorepo with a standalone MCP package

**Performance Goals**: bounded catalog and review payloads; execution remains within the existing 60-second Operator MCP deadline

**Constraints**: `operator:write` is an explicit consented scope; no separate publish scope or browser confirmation. Writes must be CAS-fenced, replay-safe, auditable without customer content, and cannot alter code-owned retrieval defaults.

**Scale/Scope**: three independent P1 workflows: structural routine CRUD, existing per-agent retrieval writes, and explicit candidate publication.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

*GATE: PASS before research; rechecked PASS after design.*

- An approved spec exists. Tasks trace to the three P1 stories and functional requirements.
- Backend test tasks precede every implementation slice (red/green/refactor).
- Existing module boundaries are retained: Operator MCP transport does not acquire product mutation rules; composition wires ports only.
- Public OpenAPI, Operator MCP contract, migration/schema, generated MCP OpenAPI types, and TypeScript SDK snapshots are regenerated together.
- Queue review: no document-worker or AMQP handoff is introduced. Routine/retrieval/revision mutations run through their existing synchronous domain services; their current asynchronous consequences, if any, remain owned by those services. No queue payload, retry policy, queue test, or queue documentation changes are expected.
- Audit events record operation/review identifiers, safe outcome/reason and actor/client attribution only. They never include prompts, graph bodies, retrieval contents, credentials, or raw configuration.
- Documentation parity covers Operator MCP scope/confirmation/tool use and generated product-doc corpus if documentation changes.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file ($speckit-plan command output)
├── research.md          # Phase 0 output ($speckit-plan command)
├── data-model.md        # Phase 1 output ($speckit-plan command)
├── quickstart.md        # Phase 1 output ($speckit-plan command)
├── contracts/           # Phase 1 output ($speckit-plan command)
└── tasks.md             # Phase 2 output ($speckit-tasks command - NOT created by $speckit-plan)
```

### Source Code

```text
backend/
├── src/modules/operatorCopilot/      # reviewed-operation orchestration and catalog dispositions
├── src/modules/routines/             # canonical graph transform/validation and draft writes
├── src/modules/agents/               # revision candidate and publication lifecycle
├── src/modules/agentSkills/          # existing per-agent retrieval configuration lifecycle
├── src/modules/retrieval/            # retrieval override schemas/resolution, not workspace-default writes
├── src/modules/operatorMcpAuthorization/ # grant scope parsing/consent and execution revalidation
├── src/db/{migrations,repositories}/ # reviewed-operation persistence and generated schema
├── src/app/http/openapi/             # code-first contract registration
└── tests/{unit,integration,contract}/operatorCopilot/
packages/
├── operator-mcp-contract/            # scope/shape and cross-process DTO schemas
├── radioso-mcp-server/src/operator/  # stateless MCP request dispatch only
└── product-docs/                     # generated documentation corpus when docs change
typescript-sdk/{openapi,src/generated}/ # synchronized public API snapshot
docs/operator-mcp.md                  # operator-facing workflow reference
```

**Structure Decision**: `operatorCopilot` owns the review/execution lifecycle
and generic MCP descriptors. The owning routines, agents and settings modules
provide narrow prepare/preview/apply ports and keep their validation and writes.
`operatorMcpAuthorization` owns grants and revalidates current authority.
The standalone package maps only MCP calls onto backend admission/invocation.

## Module Ownership & Seams

- **Transport Layer**: `mcpRoutes.ts`, Operator MCP backend adapter and request handler parse and present contracts only.
- **Orchestration Layer**: a focused reviewed-operation service creates/reconciles/cancels review artifacts, fences execution, and records safe outcomes.
- **Domain Layer**: routines own deterministic transform semantics; agentSkills/retrieval own supported agent overrides; agents own draft/revision/candidate/publication rules.
- **Persistence/Integration Layer**: a repository persists operation identity, digest, binding, expiry, state and safe result reference. It does not persist graph or retrieval content unless the existing owning proposal/candidate store requires it.
- **Application Composition**: add default repository/service wiring in `backend/src/app/composition/` only if the new reviewed-operation port is cross-module runtime infrastructure.
- **Files Kept Small**: `mcpApplicationService.ts` remains admission/invocation wiring; `operatorMcpDisposition.ts` remains registry data; route and OpenAPI assembly modules do not acquire domain rules.
- **Planned Extractions**: reviewed-operation domain types, repository port, lifecycle service, and target-specific executor adapters.
- **Required Refactor Stories**: first establish the reviewed-operation seam before exposing an `operator:write` descriptor; do not retrofit confirmation logic into generic invocation receipts.

## Complexity Tracking

No constitution exception is required. The design adds a narrow lifecycle only
after comparing the current invocation and proposal ledgers. It will reuse
their idempotency/recovery storage where they already express the operation;
any new persisted record is limited to the missing immutable target/fence/digest/
expiry boundary and must not duplicate a second generic state machine.
