# Implementation Plan: Structured Lexical Query Plans

**Branch**: `053-lexical-query-plan` | **Date**: 2026-04-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/053-lexical-query-plan/spec.md`

## Summary

Radioso will stop treating LLM lexical alternatives as one plain-text query. The implementation will normalize model-produced lexical alternatives into existing retrieval subqueries, run those alternatives as bounded lexical branches, and compile each branch with safer PostgreSQL full-text query parsing. This preserves the existing retrieval pipeline stage contracts while improving exact phrase and OR-style alternative recall.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector`; no schema change planned  
**Testing**: Vitest unit tests and focused integration coverage where needed  
**Target Platform**: Node.js backend service  
**Project Type**: Backend retrieval feature in existing web application  
**Performance Goals**: Preserve bounded lexical retrieval by capping generated alternatives and per-branch candidates  
**Constraints**: No retrieval pipeline stage contract changes; no public chat/retrieval API contract changes; no custom BM25 engine; no new search service  
**Scale/Scope**: Existing retrieval path only; frontend changes are not required unless additive diagnostics need display adjustments

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. **PASS**
- Backend work includes TDD with failing tests written before implementation. **PASS: tasks require tests before implementation**
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. **PASS: no new UI surface planned**
- Stack remains Node.js for backend and React for frontend. **PASS**
- Database is PostgreSQL with `pgvector` for embeddings and vector search. **PASS**
- LLM provider is GPT-5.2 for AI integrations. **PASS**
- Secrets and keys are managed via `.env` and `.env.example` is updated. **PASS: no new secrets/config expected**
- Customer data handling and auditability are addressed where applicable. **PASS: diagnostics use normalized retrieval intent, not new data collection**
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **PASS**
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. **PASS**
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. **PASS: focused helper module planned**
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. **PASS: no backend HTTP contract changes**
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. **PASS: retrieval tuning/settings docs reviewed for prompt/diagnostics wording**

## Project Structure

### Documentation (this feature)

```text
specs/053-lexical-query-plan/
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
├── prompts/retrieval/
│   └── query-rewrite-system.md
├── src/modules/retrieval/
│   ├── domain/
│   │   └── lexicalQueryPlan.ts
│   ├── infra/
│   │   └── lexicalSearch.ts
│   └── services/
│       └── queryRewriteService.ts
└── tests/unit/
    ├── lexical-query-plan.test.ts
    ├── hybrid-retrieval-search.test.ts
    └── query-rewrite-subqueries.test.ts
```

**Structure Decision**: Keep the feature in the backend retrieval module. Add focused domain helper logic for lexical alternative normalization. Keep `queryRewriteService.ts` responsible for consuming rewrite output, not SQL compilation. Keep `lexicalSearch.ts` responsible for backend-specific PostgreSQL full-text query compilation and execution.

## Module Ownership & Seams

- **Transport Layer**: Existing chat and retrieval routes remain unchanged and do not know about lexical plan syntax.
- **Orchestration Layer**: `QueryInterpretationStageService` and `CandidateRetrievalStageService` continue sequencing existing stage results. `retrievalPipelineStages.ts` remains source-compatible.
- **Domain Layer**: `backend/src/modules/retrieval/domain/lexicalQueryPlan.ts` owns splitting, normalization, branch budgeting, and fallback-safe lexical alternative generation.
- **Persistence/Integration Layer**: `PgLexicalSearch` owns PostgreSQL full-text query construction and ranking.
- **Files Kept Small**: `retrievalPipelineService.ts`, chat route handlers, and `retrievalPipelineStages.ts` must not absorb lexical parsing or compilation.
- **Planned Extractions**: Add lexical plan normalization helper; update prompt asset to request structured alternatives in existing subquery fields; improve Postgres lexical query parser from plain query parsing to web-search-style parsing where safe.
- **Required Refactor Stories**: None. Existing `retrievalSubqueries` provide a contract-stable branch seam.

## Complexity Tracking

No constitution violations.
