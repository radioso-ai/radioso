# Implementation Plan: Triggered Retrieval Filters

**Branch**: `[048-triggered-retrieval-filters]` | **Date**: 2026-04-23 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/048-triggered-retrieval-filters/spec.md`

## Summary

Add optional free-form trigger instructions to retrieval metadata rules so retrieval narrowing only activates for matching turns, skip trigger analysis entirely when no triggerable rules exist, evaluate `today()` as a bounded execution-time date token, and extend retrieval diagnostics, trace, history, and the retrieval settings UI so trigger decisions and fallback/backoff behavior are clearly inspectable. The implementation keeps trigger matching inside query interpretation, exposes it as its own logical trace node, and preserves completions as the v1 authority for trigger enactment.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, Zod, `pg`, Pino, OpenAI SDK, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives  
**Storage**: PostgreSQL 16 with existing `retrieval_settings.attribute_controls` JSON payloads plus existing `audit_events.metadata_json` diagnostics surfaces  
**Testing**: Vitest and Supertest for backend TDD; Vitest for targeted frontend coverage where the feature changes client-side rule editing behavior  
**Target Platform**: Radioso backend retrieval pipeline and authenticated web dashboard settings/history surfaces
**Project Type**: Web application  
**Performance Goals**: Preserve existing retrieval latency for workspaces without triggerable rules by skipping trigger matching entirely; keep trigger diagnostics bounded in payload size  
**Constraints**: Trigger matching remains inside query interpretation; completions are authoritative in v1; embeddings may only be optional preselection later; no hidden chain-of-thought or unbounded prompt logging; no new operator scripting language or intent enum  
**Scale/Scope**: One retrieval-settings contract, the retrieval pipeline query-interpretation/candidate-preparation path, existing trace/history diagnostics surfaces, and the retrieval settings dashboard panel

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated.
- Customer data handling and auditability are addressed where applicable.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work.

Result: PASS. The feature stays within the approved stack and uses the existing settings and retrieval architecture. Because `retrievalSettings.ts`, `queryRewriteService.ts`, and `retrieval-settings-panel.tsx` already carry substantial responsibility, the implementation must introduce focused trigger-analysis and metadata-rule evaluation helpers rather than continuing to expand those files with mixed concerns.

## Project Structure

### Documentation (this feature)

```text
specs/048-triggered-retrieval-filters/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── routes/settingsRoutes.ts
│   ├── modules/
│   │   ├── settings/
│   │   │   ├── domain/retrievalSettings.ts
│   │   │   └── services/retrievalSettingsService.ts
│   │   ├── retrieval/
│   │   │   ├── domain/retrievalPipelineTypes.ts
│   │   │   └── services/
│   │   │       ├── queryInterpretationStage.ts
│   │   │       ├── queryRewriteService.ts
│   │   │       ├── candidatePreparationStage.ts
│   │   │       ├── metadataRuleScoringService.ts
│   │   │       ├── retrievalDiagnosticsStage.ts
│   │   │       ├── retrievalInfoPresenter.ts
│   │   │       ├── retrievalTraceAssembler.ts
│   │   │       └── retrievalTracePresenter.ts
│   │   └── chat/services/chatHistoryService.ts
│   └── db/repositories/retrievalSettingsRepository.ts
├── openapi.yaml
├── openapi.json
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── components/dashboard/
│   ├── chat-retrieval-info.tsx
│   ├── chat-retrieval-trace-detail.tsx
│   ├── chat-history-view.tsx
│   └── settings/retrieval-settings-panel.tsx
└── lib/api.ts
```

**Structure Decision**: Keep retrieval settings transport and persistence in the existing settings route/domain/service path. Introduce focused retrieval trigger-analysis and dynamic-date helpers under `backend/src/modules/retrieval/services/` and `backend/src/modules/settings/domain/` so query interpretation owns trigger classification, candidate preparation owns enactment/backoff and date evaluation, and trace/history presenters only consume structured facts. The dashboard retrieval settings panel remains the sole UI authoring surface for rule configuration, while history and trace components remain presentation-only.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/openapi/document.ts`, and `frontend/lib/api.ts` own request/response schemas and client payload mapping only.
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts`, `backend/src/modules/retrieval/services/queryInterpretationStage.ts`, `candidatePreparationStage.ts`, and `retrievalPipelineService.ts` coordinate the workflow but delegate trigger analysis, date evaluation, and diagnostics shaping to focused helpers.
- **Domain Layer**: `backend/src/modules/settings/domain/retrievalSettings.ts` owns persisted rule validation/normalization; new focused retrieval services own trigger-match parsing, trigger-skip decisions, and dynamic-date evaluation semantics.
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts` continues to persist additive settings payloads; model integration stays behind the query-rewrite/trigger gateway seam; audit persistence continues through existing chat and audit paths.
- **Files Kept Small**: `queryRewriteService.ts` must not absorb settings parsing or candidate scoring; `metadataRuleScoringService.ts` must not absorb prompt construction or trigger settings persistence; `retrieval-settings-panel.tsx` must not own client-side policy evaluation rules; history and trace components must remain presentation-only.
- **Planned Extractions**:
  - trigger-analysis result types in retrieval domain types
  - trigger-analysis helper/gateway in retrieval services
  - dynamic date token parsing/evaluation helper for metadata rules
  - focused UI helpers for trigger mode text and `today()` affordances if panel complexity requires separation
- **Required Refactor Stories**: Extract trigger-analysis logic and date-value resolution into focused modules before wiring them through `queryInterpretationStage.ts` and `metadataRuleScoringService.ts`; do not continue growing those files with inline mixed concerns.

## Documentation & Contract Impact

- Backend HTTP settings contract changes require updates to `backend/src/app/http/openapi/document.ts` plus regeneration of `backend/openapi.yaml` and `backend/openapi.json`.
- Operator-facing retrieval settings documentation under `frontend/docs/settings-docs/` must be updated for triggerable rules and `today()` semantics.
- Repo-level `readme.md` only needs updating if the feature materially changes the most important retrieval settings operators are likely to tune; verify near closeout.

## Complexity Tracking

No constitution violations expected.
