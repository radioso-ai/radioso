# Implementation Plan: Generic Retrieval Signal Policies

**Branch**: `028-signal-policy-engine` | **Date**: 2026-03-26 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/spec.md)
**Input**: Feature specification from `/specs/028-signal-policy-engine/spec.md`

## Summary

Replace the legacy retrieval `attributeControls` enum model with generic `signalPolicies`, add additive persistence migration for existing workspaces, refactor retrieval matching into typed signal evaluators, and update the retrieval settings UI to manage generic signal policies instead of the four hard-coded legacy families.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; additive retrieval-settings migration for `signal_policies` plus compatibility reads from legacy `attribute_controls`  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; frontend validation through existing settings UI flows and feature quickstart  
**Target Platform**: Web application with authenticated admin settings UI and Node.js backend APIs  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current retrieval latency and settings load/save responsiveness while making signal-policy scoring a low-overhead step on the candidate set already being prepared  
**Constraints**: Keep current retrieval quality for supported date/amount/location constraints, avoid breaking legacy workspaces, keep HTTP contracts code-first, and avoid introducing a user-authored rules DSL  
**Scale/Scope**: Cross-cutting backend/frontend feature touching retrieval settings persistence, settings HTTP contract, retrieval-domain parsing/scoring, diagnostics, OpenAPI, and the retrieval settings UI

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/028-signal-policy-engine/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks require failing unit/contract/integration coverage for settings migration and signal-policy retrieval before implementation changes.
- Stack remains Node.js for backend and React for frontend. Pass: TypeScript/Node backend and React/Next frontend only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive retrieval-settings migration only; no storage stack change.
- LLM provider is GPT-5.2 for AI integrations. Pass: no provider change.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass: workspace-scoped settings remain bearer-authenticated and existing audit logging for settings updates remains intact.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned extractions listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `settingsRoutes.ts`, `retrievalSettingsService.ts`, `settings-view.tsx`, and the retrieval pipeline stage files are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: signal-policy domain and evaluator seams land before route/UI rewiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: retrieval settings schemas must be updated there and generated artifacts refreshed.

## Project Structure

### Documentation (this feature)

```text
specs/028-signal-policy-engine/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── retrieval-settings-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   └── http/
│   │       ├── openapi/
│   │       │   └── document.ts
│   │       └── routes/
│   │           └── settingsRoutes.ts
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 010_signal_policies.sql
│   │   └── repositories/
│   │       └── retrievalSettingsRepository.ts
│   └── modules/
│       ├── retrieval/
│       │   ├── domain/
│       │   │   ├── retrievalPipelineTypes.ts
│       │   │   └── structuredAttributes.ts
│       │   └── services/
│       │       ├── queryConstraintParser.ts
│       │       ├── queryInterpretationStage.ts
│       │       ├── retrievalPipelineStages.ts
│       │       ├── candidatePreparationStage.ts
│       │       ├── attributeMatchScoringService.ts
│       │       └── signalEvaluatorRegistry.ts
│       └── settings/
│           ├── domain/
│           │   └── retrievalSettings.ts
│           └── services/
│               └── retrievalSettingsService.ts
└── tests/
    ├── contract/
    │   └── settings.contract.test.ts
    ├── integration/
    │   ├── document-settings.integration.test.ts
    │   └── retrieval-benchmark.integration.test.ts
    └── unit/
        ├── retrieval-settings-and-chunking.test.ts
        ├── retrieval-pipeline-stages.test.ts
        ├── hybrid-query-constraints.test.ts
        └── edge-cases.test.ts

frontend/
├── components/
│   └── dashboard/
│       └── settings-view.tsx
└── lib/
    └── api.ts
```

**Structure Decision**: Keep transport and contract changes in `backend/src/app/http/routes/settingsRoutes.ts` and `backend/src/app/http/openapi/document.ts`. Keep settings orchestration in `retrievalSettingsService.ts` and persistence in `retrievalSettingsRepository.ts`, but add a new signal-policy representation plus compatibility translation there. In retrieval, keep parsing, query preparation, and candidate scoring split across their current stages, but introduce a dedicated evaluator seam so the scoring service no longer embeds per-family matching logic. On the frontend, keep `settings-view.tsx` as the retrieval settings container while replacing only the retrieval-policy section with a generic signal-policy editor.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts` accepts and validates retrieval settings payloads only; `backend/src/app/http/openapi/document.ts` owns code-first runtime schemas; `frontend/components/dashboard/settings-view.tsx` owns form presentation and save flow only.
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts` loads, validates, and persists workspace retrieval settings without owning scoring rules; `backend/src/modules/retrieval/services/queryInterpretationStage.ts` prepares parsed constraints for retrieval without owning persistence details.
- **Domain Layer**: `backend/src/modules/settings/domain/retrievalSettings.ts` owns signal-policy types/defaults/validation and legacy translation helpers; `backend/src/modules/retrieval/services/signalEvaluatorRegistry.ts` and companion retrieval-domain types own constraint evaluation logic.
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts` owns `signal_policies` storage and read compatibility for legacy rows; the migration owns database backfill.
- **Files Kept Small**: `settingsRoutes.ts` must not absorb migration logic; `retrievalSettingsService.ts` must not absorb retrieval scoring; `settings-view.tsx` must not become a rules engine or backend schema source of truth; `attributeMatchScoringService.ts` must not gain more special-case branches.
- **Planned Extractions**:
  - retrieval signal-policy domain types and defaults
  - legacy-to-signal-policy translation helpers
  - typed signal evaluator registry for retrieval matching
  - frontend signal-policy metadata helpers for display labels and descriptions
- **Required Refactor Stories**:
  - introduce signal-policy domain/persistence seam before UI and retrieval-scoring rewiring
  - move scoring from family-specific checks to evaluator-based dispatch before adding new policy plumbing to retrieval stages
  - update code-first OpenAPI schemas and contract tests as part of the same slice as the settings API rename

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/research.md) for the migration, policy-model, evaluator-registry, and UI-catalog decisions.

## Phase 1: Design & Contracts

- The workspace retrieval settings and signal-policy entities are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/data-model.md).
- The retrieval settings contract changes are defined in [retrieval-settings-contract.md](/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/contracts/retrieval-settings-contract.md).
- Validation scenarios for legacy loading, settings saves, and retrieval behavior are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because migration behavior, settings validation, and signal evaluation all have isolated seams for failing tests first.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints remain unchanged.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files treated as outputs only.
- Ownership seams are improved: settings persistence remains in the settings module, evaluator logic moves into retrieval-domain services, and UI presentation remains in the settings view instead of becoming schema logic.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
