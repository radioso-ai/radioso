# Implementation Plan: Performance Benchmarking

**Branch**: `037-performance-benchmarking` | **Date**: 2026-04-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/037-performance-benchmarking/spec.md`

## Summary

Add a repo-owned performance benchmarking harness that defines repeatable workload profiles, performance budgets, and baseline-comparison rules for Radioso while keeping heavy load generation outside the main app process. The first release will cover API-only, chat, ingestion, mixed, stress, and soak profiles; collect latency, throughput, error, and backlog metrics; persist gitignored run artifacts; and compare new runs against accepted baselines without introducing benchmark-specific production routes by default.

## Technical Context

**Language/Version**: Node.js 22 ESM scripts for the benchmark harness, plus existing TypeScript 5.x backend and TypeScript 5.7 frontend  
**Primary Dependencies**: existing Node.js toolchain, `pg`, Docker Compose, benchmark-harness dependencies for HTTP load generation and result formatting, existing backend/frontend package scripts  
**Storage**: PostgreSQL 16 for app state under test; filesystem-backed benchmark definitions in the repo and gitignored run artifacts under `.context/performance-runs/`  
**Testing**: Node test runner or Vitest for profile/schema/result-comparison logic, integration smoke runs against local Compose stack, targeted regression tests for budget evaluation and collector safety  
**Target Platform**: Local development hosts, Docker Compose development stack, and staging-like Linux container environments  
**Project Type**: Web application with repo-owned operational tooling  
**Performance Goals**: Repeatable profile execution, clear regression detection against baselines, local smoke profiles that complete in under 10 minutes, and stress/soak profiles that expose saturation and recovery boundaries rather than averages only  
**Constraints**: Keep benchmark source of truth in the repo, avoid benchmark logic in production HTTP routes unless black-box observation proves insufficient, keep load generation out-of-process, protect secrets and customer data, and classify which profiles are safe in local versus shared environments  
**Scale/Scope**: Six benchmark profile families, baseline comparison, metrics collection for API/chat/ingestion/mixed traffic, and operator/developer documentation for benchmark usage and interpretation

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated only if benchmark configuration requires new documented env vars.
- Customer data handling and auditability are addressed by keeping benchmark datasets bounded, preferring synthetic or controlled fixtures, and avoiding new broad production data exposure.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit: benchmark orchestration lives in tooling, app routes stay transport-only, and database observation stays in focused collector adapters.
- Existing responsibility-limited files are identified, and the plan avoids turning runtime entrypoints, route handlers, or the worker into benchmark god objects.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas.
- Backend HTTP contracts are not expected to change in the initial release; if a read-only diagnostics route becomes necessary, ownership will remain in `backend/src/app/http/openapi/document.ts`, with `backend/openapi.yaml` and `backend/openapi.json` treated as generated outputs only.
- Contracts, workflows, and developer/operator docs will change, so documentation updates are required in the same feature work.

## Project Structure

### Documentation (this feature)

```text
specs/037-performance-benchmarking/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── benchmark-artifacts.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
scripts/
├── performance/
│   ├── runProfile.mjs
│   ├── compareBaseline.mjs
│   ├── lib/
│   │   ├── profiles/
│   │   ├── workloads/
│   │   ├── collectors/
│   │   ├── budgets/
│   │   ├── reporting/
│   │   └── env/
│   └── fixtures/
└── bootstrap/

backend/
├── src/
│   ├── db/repositories/
│   ├── modules/
│   │   ├── chat/services/
│   │   └── documents/services/
│   └── shared/infra/
├── tests/
└── package.json

frontend/
├── app/
├── components/
└── lib/

infra/
├── docker-compose.yml
└── docker-compose.dev.yml

.context/
└── performance-runs/        # gitignored benchmark artifacts and saved local baselines
```

**Structure Decision**: Keep benchmark definitions and orchestration in a dedicated top-level `scripts/performance/` toolchain rather than embedding them into the backend runtime. Reuse the existing app stack as the system under test. Keep any benchmark-specific observation logic in focused collector adapters that read public HTTP behavior and bounded database snapshots. Store ephemeral run results and machine-specific baselines in `.context/performance-runs/` so the source of truth stays in the repo while noisy artifacts stay out of version control.

## Module Ownership & Seams

- **Transport Layer**:
  - `scripts/performance/runProfile.mjs`
  - `scripts/performance/compareBaseline.mjs`
  - package scripts or shell entrypoints that parse user input and print bounded reports
- **Orchestration Layer**:
  - profile runner orchestration
  - benchmark environment bootstrap and validation
  - baseline selection and comparison sequencing
- **Domain Layer**:
  - benchmark profile definitions
  - workload classes and safety tiers
  - performance budget evaluation
  - regression verdict logic
- **Persistence/Integration Layer**:
  - HTTP load generators targeting backend and frontend endpoints
  - PostgreSQL snapshot collectors for queue depth and job age
  - filesystem artifact writers/readers for run results and accepted baselines
  - Docker Compose adapters for local environment orchestration
- **Files Kept Small**:
  - `backend/src/app/http/routes/*`
  - `backend/src/app/server/dependencies.ts`
  - `backend/src/modules/documents/services/documentProcessingWorker.ts`
  - `frontend/lib/api.ts`
- **Planned Extractions**:
  - benchmark profile schema validator
  - workload adapter boundary between load generation and profile definitions
  - collector adapter layer for HTTP, database, process, and optional external metrics
  - result reporter and baseline comparer
- **Required Refactor Stories**:
  - none initially, provided backlog and saturation signals can be captured through black-box traffic plus bounded database collectors
  - if black-box collection proves insufficient, add a narrowly scoped read-only diagnostics seam before adding any broader benchmark hooks

## Phase 0: Research

Research decisions are captured in [research.md](./research.md).

## Phase 1: Design & Contracts

Design artifacts are captured in:

- [data-model.md](./data-model.md)
- [quickstart.md](./quickstart.md)
- [benchmark-artifacts.md](./contracts/benchmark-artifacts.md)

## Delivery Phases

### Phase 2: Benchmark Foundation

1. Add the benchmark profile schema, environment-safety classifier, and result/baseline models.
2. Add failing tests for profile validation, budget evaluation, and baseline comparison behavior.
3. Add repo entrypoints for running a profile and comparing a run to a baseline.

### Phase 3: Collector And Workload Adapters

1. Add HTTP workload adapters for API-only, chat, ingestion, and mixed traffic.
2. Add bounded PostgreSQL collectors for queue depth, queued-job age, and other worker-backlog signals.
3. Add run-artifact persistence under `.context/performance-runs/` with stable result metadata.

### Phase 4: Profile Families

1. Implement local smoke profiles for API, chat, and ingestion.
2. Implement mixed-workload profiles that exercise API and worker pressure together.
3. Implement at least one stress profile and one soak profile with explicit environment-safety gates.

### Phase 5: Baselines, Budgets, And Reporting

1. Add accepted-budget definitions and baseline-comparison output.
2. Distinguish regressions, within-tolerance variance, and inconclusive runs caused by noise or missing prerequisites.
3. Surface when external dependencies dominate the result instead of Radioso itself.

### Phase 6: Validation And Documentation

1. Add integration smoke validation against the local Compose stack.
2. Document benchmark setup, safe usage tiers, result interpretation, and baseline workflow.
3. Decide whether any lightweight CI benchmark check should run by default or remain manual/pre-release only.

## Testing Strategy

- Backend-adjacent and tooling changes follow TDD where code is added: write failing tests first for profile validation, budget evaluation, comparison logic, and collector parsing.
- Integration smoke runs verify that benchmark tooling can stand up against the local Compose environment and emit bounded results.
- Safety tests verify that shared-environment or destructive profiles are rejected unless the target environment class explicitly allows them.
- Regression tests cover queue-backlog detection, baseline diffing, and inconclusive-run handling.

## Risks And Mitigations

- **Risk**: Real LLM latency swamps app-level bottlenecks and makes runs too noisy.  
  **Mitigation**: Support separate profile classes for mocked, bounded, and real-provider runs; compare like with like.

- **Risk**: Benchmark logic leaks into the production app surface.  
  **Mitigation**: Keep the initial harness external to app runtimes and add read-only app hooks only if black-box collectors prove insufficient.

- **Risk**: Results become untrustworthy because each engineer runs different workloads.  
  **Mitigation**: Make named profiles and budgets the only supported source of truth; keep ad hoc runs explicitly separate from accepted baselines.

- **Risk**: Heavy profiles are accidentally run against shared developer or staging environments.  
  **Mitigation**: Add environment-safety tiers, explicit acknowledgements for stress/soak profiles, and default local-smoke profiles for routine use.

- **Risk**: Machine-specific baselines create noisy version-controlled diffs.  
  **Mitigation**: Keep ephemeral results and machine-local baselines in `.context/`, while committing only benchmark definitions and shared budget rules.

## Complexity Tracking

No constitution violations are required for this feature.
