# Implementation Plan: Date-Aware Event Retrieval via Shape-Aware Ingestion Enrichment

**Branch**: `date-aware-event-retrieval` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/099-date-aware-event-retrieval/spec.md`

**Planning note**: `.specify/scripts/bash/setup-plan.sh --json` and
`.specify/scripts/bash/check-prerequisites.sh --json` were attempted from the
repo root, but both reject the current branch name because it does not start
with `099-`. The user explicitly selected this branch and feature directory and
instructed not to switch branches, so planning proceeds manually from the
templates.

## Summary

Add opt-in document enrichment that classifies document shape and extracts
temporal facts in one structured LLM call per processed document. The document
pipeline will apply extracted `dateFrom`/`dateTo` metadata at document or chunk
level, render per-chunk search text from final chunk metadata, and persist
enrichment provenance without breaking processing on enrichment failures. The
retrieval pipeline will consume only chunk metadata and per-agent
`retrieval.answer` skill settings to support upcoming-event lookup, boosting,
and deterministic ordering. Public API/UI changes cover workspace/source/run
enablement, source reprocessing, document enrichment provenance, retrieval
settings, SDK/MCP generated surfaces, and docs parity.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 backend; TypeScript 5.7, React 19, Next.js 16 frontend  
**Primary Dependencies**: Express, Zod, Pino, OpenAI/provider registry, Radix/shadcn UI, Lucide icons  
**Storage**: PostgreSQL 16 with `pgvector`; chunk embeddings in `chunks`, document/source/job state in Postgres  
**Testing**: Vitest, Supertest contract/integration tests, Playwright for user-visible frontend flows  
**Target Platform**: Self-hosted Radioso backend worker/API plus authenticated dashboard frontend  
**Project Type**: Web application with backend, frontend, TypeScript SDK, MCP package, docs portal  
**Performance Goals**: Exactly one enrichment LLM call per enriched document; no enrichment call when disabled; temporal range lookup is indexed via generated date columns on chunks  
**Constraints**: Enrichment disabled by default; no English keyword lists for temporal product meaning; enrichment failure must leave document ready and observable; AMQP message schema unchanged; generated OpenAPI/SDK/MCP artifacts updated during implementation but not hand-edited  
**Scale/Scope**: Existing document processing, retrieval, source settings, agent settings, workbench eval, public API, SDK, MCP, and docs surfaces for feature 099

## Constitution Check

*GATE: Pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec-first delivery**: PASS. `specs/099-date-aware-event-retrieval/spec.md` exists and is approved.
- **Backend TDD**: PASS with task enforcement. `tasks.md` orders backend unit, integration, and contract tests before implementation tasks in each story.
- **Frontend testing discipline**: PASS. User-visible settings/source/document flows use Playwright first; frontend unit tasks cover only API adapter/settings serialization logic.
- **Stack discipline**: PASS. Backend remains Node.js/Express TypeScript; frontend remains React/Next.js; storage remains PostgreSQL/pgvector.
- **LLM provider default**: PASS. Enrichment is a backend LLM integration through existing provider registry defaults; no new provider or secret is planned.
- **Secrets/config hygiene**: PASS. No new secret/config is required. If implementation discovers a model capability flag is needed, `.env.example` must be updated in that implementation change.
- **Customer data protection and reliability**: PASS. Enrichment logs/traces omit document content, prompts, completions, chunks, and credentials; failures degrade to unenriched `ready` documents with audit/log/provenance.
- **Modularity and encapsulation**: PASS. Ingestion enrichment contracts live in `backend/src/modules/documents/domain/enrichment/`; orchestration stays in `documentProcessingService.ts`; retrieval consumes only `dateFrom`/`dateTo` chunk metadata.
- **Responsibility-limited files**: PASS. `backend/src/modules/documents/services/documentProcessingService.ts` gets one stage call and no extraction logic. `backend/src/modules/retrieval/services/candidateRetrievalStage.ts` and `candidatePreparationStage.ts` coordinate ports but do not own HTTP, ingestion, or prompt-copy behavior. HTTP routes validate and delegate.
- **Required refactor/extraction**: PASS. New ports/modules are required before story implementation: enrichment contracts/strategy registry, enablement resolver, per-chunk metadata patching helper, temporal candidate retrieval port, and deterministic temporal ordering helper.
- **Application composition**: PASS. New enrichment strategy registry and temporal candidate retrieval adapter are replaceable runtime infrastructure and must be wired through `backend/src/app/composition/` / module composition entrypoints, keeping product rules in `backend/src/modules/`.
- **OpenAPI code-first contracts**: PASS. Actual code-first targets are `backend/src/app/http/openapi/openApiDocument.ts`, `backend/src/app/http/openapi/openApiPaths.ts`, `backend/src/app/http/openapi/paths/documentsPaths.ts`, `settingsPaths.ts`, and related schema modules. `backend/openapi.yaml` and `backend/openapi.json` are generated outputs for implementation, not planning sources.
- **Message-queue impact review**: PASS. Reprocess options are planned on the `document_processing_jobs` row. `backend/src/modules/documents/services/documentJobMessage.ts`, AMQP/Cloud Tasks dispatchers, and queue docs/tests remain schema-compatible; retry/reschedule preserves the same job row/options.
- **Documentation parity**: PASS. Docs inventory is explicit below and tasks include docs updates for settings, sources, API, MCP, SDK, document processing, retrieval, and docs-portal equivalents.
- **Prompt asset ownership**: PASS. New runtime prompt lives at `backend/prompts/ingestion/document-enrichment.md`; prompt loader/build/Docker tests must align with that location.

**Post-design re-check**: PASS. Research, data model, contract notes, and tasks preserve the same gates. No constitution violation is intentionally accepted.

## Project Structure

### Documentation (this feature)

```text
specs/099-date-aware-event-retrieval/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── http-contract-notes.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── prompts/
│   └── ingestion/document-enrichment.md
├── src/
│   ├── app/composition/
│   ├── app/http/routes/
│   ├── app/http/openapi/
│   ├── db/migrations/
│   ├── db/repositories/
│   └── modules/
│       ├── documents/
│       │   ├── domain/enrichment/
│       │   ├── services/
│       │   └── infra/
│       ├── retrieval/
│       │   ├── domain/
│       │   ├── services/
│       │   └── infra/
│       └── settings/
└── tests/
    ├── unit/
    ├── integration/
    └── contract/

frontend/
├── components/dashboard/
├── lib/
└── tests/
    ├── e2e/
    └── unit/

packages/radioso-mcp-server/
├── src/
└── tests/

typescript-sdk/
├── src/
└── tests/

docs/
docs-portal/content/
```

**Structure Decision**: Use the existing backend/frontend/package/docs layout.
Do not introduce a new package. Domain contracts and pure rules go under owning
modules; persistence adapters stay under `backend/src/db/repositories/`;
runtime wiring stays in app/module composition; generated contracts are updated
by the existing generation flows during implementation.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/documentRoutes.ts`: source/document reprocess endpoints and request validation only.
  - `backend/src/app/http/routes/settingsRoutes.ts`: ingestion settings API validation/delegation only.
  - `backend/src/app/http/openapi/paths/documentsPaths.ts`, `settingsPaths.ts`, and schema modules: code-first OpenAPI registration.
  - `frontend/lib/api-documents.ts`, `frontend/lib/api-settings.ts`, `frontend/lib/retrieval-skill-settings.ts`: client adapters and serialization.

- **Orchestration Layer**:
  - `backend/src/modules/documents/services/documentProcessingService.ts`: materialize -> optional enrichment stage -> chunk -> embed -> persist; no LLM prompt details or shape-specific strategy logic.
  - `backend/src/modules/documents/services/workspaceIngestionReprocessService.ts`: reprocess orchestration for workspace and new source action; delegates DB/job dispatch.
  - `backend/src/modules/retrieval/services/retrievalPipelineService.ts` and stage services: coordinate temporal candidate retrieval/ordering through ports and settings.

- **Domain Layer**:
  - New `backend/src/modules/documents/domain/enrichment/`: `DocumentShape`, structured enrichment output schema, validation, enablement resolver, character-range overlap, strategy port, strategy implementations for event/article/profile/reference/generic, and registry contracts.
  - New retrieval domain modules under `backend/src/modules/retrieval/domain/`: temporal query mode, temporal candidate/date helpers, candidate merge/source typing, and deterministic temporal ordering rules.
  - Existing `backend/src/modules/retrieval/services/searchTextRenderer.ts` is reused for `dateFrom`/`dateTo` rendering; it should not gain extraction or retrieval strategy rules.

- **Persistence/Integration Layer**:
  - `backend/src/db/migrations/119_date_aware_event_retrieval.sql` (next migration number may change if concurrent migrations land): ingestion setting column, document source config/provenance shape support if columnized, processing job `options`, document enrichment provenance, generated chunk date columns/indexes.
  - `backend/src/db/repositories/documentRepository.ts`, `documentProcessingJobRepository.ts`, `documentSourceRepository.ts`, `ingestionSettingsRepository.ts`: Kysely/raw-allowed existing adapters updated behind ports.
  - `backend/src/modules/retrieval/infra/temporalCandidateRepository.ts`: indexed Postgres chunk date-range lookup implementing a retrieval-owned port.
  - `backend/prompts/ingestion/document-enrichment.md`: runtime LLM prompt asset for the single enrichment call.

- **Application Composition**:
  - `backend/src/modules/documents/composition.ts` exports the enrichment service/strategies.
  - `backend/src/modules/retrieval/composition.ts` wires the temporal candidate repository into default retrieval services.
  - `backend/src/app/composition/defaultComposition.ts` / `backend/src/app/server/dependencyBuilders.ts` wire default registries/adapters without domain rules.

- **Files Kept Small**:
  - `documentProcessingService.ts`: one enrichment-stage call plus final chunk metadata/search text integration only.
  - `searchTextRenderer.ts`: reuse existing date metadata rendering, no new product meaning.
  - `documentRoutes.ts`, `settingsRoutes.ts`: no business logic beyond validation and presenter/delegation.
  - `candidateRetrievalStage.ts`, `candidatePreparationStage.ts`, `contextSelectionStage.ts`: call focused helpers/ports; no keyword detection or ingestion imports.

- **Planned Extractions**:
  - `backend/src/modules/documents/domain/enrichment/documentEnrichmentContract.ts`
  - `backend/src/modules/documents/domain/enrichment/enrichmentEnablement.ts`
  - `backend/src/modules/documents/domain/enrichment/enrichmentStrategies.ts`
  - `backend/src/modules/documents/services/documentEnrichmentService.ts`
  - `backend/src/modules/retrieval/domain/temporalQueryMode.ts`
  - `backend/src/modules/retrieval/domain/temporalCandidateRetrieval.ts`
  - `backend/src/modules/retrieval/services/temporalCandidateMergeService.ts`
  - `backend/src/modules/retrieval/services/temporalContextOrdering.ts`

- **Required Refactor Stories**:
  - Foundational per-chunk metadata/search-text plumbing must land before US1 enrichment behavior.
  - Foundational job options and enablement resolver must land before US2 reprocess override behavior.
  - Foundational retrieval settings schema fields must land before US3/US4 temporal retrieval behavior.

## Message-Queue Impact Review

- **AMQP/Cloud Tasks message schema**: No change. `backend/src/modules/documents/services/documentJobMessage.ts` remains `{ jobId, documentId?, workspaceId?, revision? }`.
- **Durable job row**: Add nullable `options` to `document_processing_jobs`; enrichment override rides on the row and is loaded by worker after claim.
- **Dispatch behavior**: Existing dispatchers continue to wake workers by job id. New per-source/workspace/single-document reprocess paths create jobs with options, then dispatch unchanged messages.
- **Retry semantics**: `reschedule`, `releaseTimedOutClaim`, and claim paths must return/preserve `options` on the same row. Options must not leak to future jobs for the same document.
- **Queue tests/docs**: Update `backend/tests/unit/amqp-document-job-queue.test.ts` only to assert message compatibility remains unchanged if needed; update docs-portal document processing lifecycle and message queue references if they describe reprocess payload behavior.

## OpenAPI / SDK / MCP Contract Review

- **Backend code-first targets**:
  - `backend/src/app/http/routes/documentRouteSchemas.ts`
  - `backend/src/app/http/routes/settingsRouteSchemas.ts`
  - `backend/src/app/http/openapi/paths/documentsPaths.ts`
  - `backend/src/app/http/openapi/paths/settingsPaths.ts`
  - `backend/src/app/http/openapi/schemas/settingsSchemas.ts`
  - document schemas registered through the existing OpenAPI schema catalog
- **Generated outputs during implementation**:
  - `backend/openapi.yaml`, `backend/openapi.json`
  - `typescript-sdk/openapi/radioso.yaml`, `typescript-sdk/openapi/radioso.json`
  - `typescript-sdk/src/generated/types.ts`, `typescript-sdk/src/generated/client.ts`
  - `packages/radioso-mcp-server/src/generated/openapiTypes.ts`
- **MCP surface**: Update `packages/radioso-mcp-server/src/tools/writeTools.ts` and `src/radiosoApiAdapter.ts` so `reprocess_document` can pass optional enrichment override once the backend contract exists.
- **SDK surface**: Update generated client via sync; optionally add hand-authored convenience parameters in `typescript-sdk/src/index.ts` for document/source/workspace reprocess overrides.

## Docs Inventory

Before editing any docs in implementation, read `docs/document-writer-prompt.md`.

- Ingestion settings: `docs/settings-docs/ingestion/reprocess-existing-documents.md`, new/updated AI enrichment setting doc, and mirrored `frontend/docs/settings-docs/ingestion/*`.
- Retrieval settings: new docs for the three temporal toggles under `docs/settings-docs/retrieval/` and mirrored `frontend/docs/settings-docs/retrieval/`; update `frontend/components/dashboard/settings/settings-docs.ts`.
- Sources and ingestion workflows: `docs/website-crawler.md`, `docs-portal/content/guides/document-upload.mdx`, `docs-portal/content/operators/document-processing.mdx`, `docs-portal/content/architecture/document-processing-lifecycle.mdx`.
- API reference: `docs-portal/content/api/documents-and-search.mdx`, `docs-portal/content/api/settings.mdx`, `docs/api-contract-workflow.md` only if workflow guidance changes.
- Retrieval architecture: `docs/architecture/vector-search-indexing.md`, `docs-portal/content/architecture/retrieval-pipeline.mdx`.
- SDK and MCP: `docs/typescript-sdk-basic-usage.md`, `docs/typescript-sdk-getting-started.md`, `docs/mcp-client-setup.md`, `docs-portal/content/sdk/basic-usage.mdx`, `docs-portal/content/sdk/typescript-getting-started.mdx`, `packages/radioso-mcp-server/README.md`, `typescript-sdk/README.md`.
- README: `readme.md` because the feature changes ingestion/retrieval settings operators tune and common API/MCP usage.

## Complexity Tracking

No constitution violations are planned. The feature touches many files because
it changes an end-to-end product workflow, but ownership is split by existing
module boundaries and new focused ports. High file count is managed with
foundational seams before user-story behavior.
