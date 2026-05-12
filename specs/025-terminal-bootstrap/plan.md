# Implementation Plan: Terminal Bootstrap Installer

**Branch**: `025-terminal-bootstrap` | **Date**: 2026-03-23 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/lima/specs/025-terminal-bootstrap/spec.md)
**Input**: Feature specification from `/specs/025-terminal-bootstrap/spec.md`

## Summary

Replace the current workstation-specific `run-dev.sh` behavior with a real default local start command that runs from the repository root, performs preflight checks, collects and validates only the necessary environment values, renders a branded ANSI terminal experience with a pixel-style sun and clouds, and then starts the existing Docker Compose stack with clear readiness and recovery reporting.

## Technical Context

**Language/Version**: Node.js 24 ESM script for the default bootstrap entry point, plus existing Bash wrapper compatibility; existing TypeScript backend/frontend remain unchanged
**Primary Dependencies**: Node built-ins (`fs`, `path`, `child_process`, `readline`, `crypto`), Docker CLI with `docker compose`, existing Compose files under `infra/`, backend `.env.example` contract, Node test runner for bootstrap coverage  
**Storage**: Local filesystem for `backend/.env`; existing Docker-managed PostgreSQL volume via Compose  
**Testing**: `node:test` coverage for bootstrap modules plus targeted shell/integration verification of the default command path  
**Target Platform**: Local developer terminals on macOS/Linux with Docker Desktop or equivalent container runtime  
**Project Type**: Repository-root developer tooling for a web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preflight and prompt rendering should start within a few seconds; repeat runs with valid config should reach compose startup immediately after checks; success/failure summaries should be concise enough to scan without scrolling through raw compose logs  
**Constraints**: Must run before app dependencies are installed; must remain terminal-only; must not rely on browser setup; must preserve `backend/.env` secrecy; must keep compose definitions as the source of truth for runtime topology; must degrade cleanly when ANSI styling is unavailable  
**Scale/Scope**: Repository-root startup flow touching `run-dev.sh`, new bootstrap modules/scripts, `backend/.env.example`, and local-start documentation; no backend HTTP or frontend product-surface changes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/025-terminal-bootstrap/`.
- Backend work includes TDD with failing tests written before implementation. Pass: bootstrap logic will be implemented with red/green tests for preflight checks, env materialization, and terminal rendering behavior before code changes land.
- Stack remains Node.js for backend and React for frontend. Pass: bootstrap uses Node.js only; no stack deviation.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: local runtime topology remains the existing Compose PostgreSQL service.
- LLM provider is GPT-5.2 for AI integrations. Pass: defaults remain aligned with `backend/.env.example`.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: feature centers on improving `.env` generation and updating `.env.example` defaults/comments where needed.
- Customer data handling and auditability are addressed where applicable. Pass: bootstrap only handles local developer config and avoids echoing secrets back to terminal output.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass: new tooling stays outside backend transport/orchestration modules and leaves app runtime ownership intact.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `run-dev.sh`, `infra/docker-compose*.yml`, and `backend/src/app/config/env.ts` retain narrow responsibilities.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: introduce focused bootstrap modules instead of inflating `run-dev.sh`.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: no backend HTTP contract changes are planned.

## Project Structure

### Documentation (this feature)

```text
specs/025-terminal-bootstrap/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── .env.example
└── src/
    └── app/
        └── config/
            └── env.ts

infra/
├── docker-compose.yml
└── docker-compose.dev.yml

scripts/
└── bootstrap/
    ├── index.mjs
    ├── preflight.mjs
    ├── prompt-flow.mjs
    ├── env-file.mjs
    ├── terminal-theme.mjs
    ├── compose-runner.mjs
    └── support/
        ├── env-contract.mjs
        ├── ansi-capabilities.mjs
        └── process-utils.mjs

tests/
└── bootstrap/
    ├── preflight.test.mjs
    ├── prompt-flow.test.mjs
    ├── env-file.test.mjs
    └── terminal-theme.test.mjs

run-dev.sh
```

**Structure Decision**: Keep `infra/docker-compose.yml` and `infra/docker-compose.dev.yml` as the only owners of service topology. Keep `backend/src/app/config/env.ts` responsible for runtime env validation only. Replace the current workstation-copy behavior in `run-dev.sh` with a thin shell wrapper that invokes a root-level Node bootstrap module. House the new behavior in `scripts/bootstrap/` so preflight checks, prompt flow, environment writing, terminal presentation, and compose orchestration remain independently testable and do not leak into backend application modules.

## Module Ownership & Seams

- **Transport Layer**: Not applicable for product HTTP transport; the terminal entry surface is `run-dev.sh` invoking `scripts/bootstrap/index.mjs`.
- **Orchestration Layer**: `scripts/bootstrap/index.mjs` coordinates the end-to-end flow and `compose-runner.mjs` owns compose startup, readiness polling, and final status reporting.
- **Domain Layer**: `preflight.mjs` owns dependency and port rules, `prompt-flow.mjs` owns question sequencing and response validation, `env-file.mjs` owns merge/write rules for `backend/.env`, and `terminal-theme.mjs` owns ANSI art, color semantics, and fallback rendering.
- **Persistence/Integration Layer**: `support/env-contract.mjs` maps the canonical local env contract, `process-utils.mjs` wraps shell execution and process inspection, and the compose files remain the integration boundary for the local stack.
- **Files Kept Small**: `run-dev.sh` must remain a thin compatibility wrapper. `backend/src/app/config/env.ts` must not absorb interactive prompt logic. `infra/docker-compose*.yml` must not gain installer-specific state or prompt metadata.
- **Planned Extractions**:
  - dedicated bootstrap orchestrator under `scripts/bootstrap/index.mjs`
  - dedicated preflight check module
  - dedicated env contract and env file materialization modules
  - dedicated ANSI theme/art module with capability fallback handling
  - dedicated compose runner and health summary module
- **Required Refactor Stories**:
  - remove workstation-specific `.env` copying from `run-dev.sh` before adding the new default command flow
  - isolate `backend/.env.example` parsing and bootstrap metadata so prompt rules do not drift from the canonical env contract
  - introduce test seams for shell execution and terminal rendering before expanding startup logic

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/lima/specs/025-terminal-bootstrap/research.md) for the decisions on bootstrap runtime placement, env-contract ownership, and ANSI rendering/fallback strategy.

## Phase 1: Design & Contracts

- The bootstrap session, preflight result, questionnaire, env contract, and startup report models are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/lima/specs/025-terminal-bootstrap/data-model.md).
- Verification and manual usage flows for first-run setup, repeat startup, and failure recovery are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/lima/specs/025-terminal-bootstrap/quickstart.md).
- No backend HTTP contract artifact is required because this feature does not change product routes or OpenAPI ownership.

## Post-Design Constitution Check

- Backend TDD remains enforceable because the bootstrap work is isolated into testable modules with failing `node:test` coverage written before implementation.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 default-provider constraints remain unchanged.
- Secrets remain in `.env` and `.env.example`; the new flow strengthens secret handling by generating defaults and suppressing terminal echo of sensitive values.
- Existing boundaries are clearer after design: compose files stay runtime topology owners, backend env parsing stays runtime validation only, and terminal bootstrap logic lives in dedicated root tooling modules instead of application services.
- No backend HTTP contract changes or OpenAPI registry updates are required.
- No constitution violations or exceptions are required for this feature.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
