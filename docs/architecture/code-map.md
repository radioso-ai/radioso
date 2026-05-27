# Code Map

This map is a starting point for feature work. It is not a generated inventory.
Use it to find the right owner, public surface, tests, and docs before reading
large parts of the repository.

## How To Use This Map

Start with the user-facing surface, then follow the ownership boundary:

1. Find the product area below.
2. Read the public entry points and contracts before internals.
3. Check the linked docs or specs for product decisions.
4. Use the suggested searches to find current call sites.
5. Run the focused tests before broader CI.

If a feature needs several unrelated areas, write a short feature brief in
`.context/` first. See [Agent Context Workflow](../agent-context-workflow.md).

## Backend HTTP Surface

Owns request validation, authentication middleware, response presentation, and
OpenAPI registration.

Should not own domain decisions, queue selection, provider behavior, retrieval
ranking, or storage-specific logic.

Primary paths:

- `backend/src/app/http/README.md`
- `backend/src/app/http/routes/`
- `backend/src/app/http/schemas/`
- `backend/src/app/http/presenters/`
- `backend/src/app/http/middleware/`
- `backend/src/app/http/openapi/`

Useful searches:

- `rg "router\\." backend/src/app/http/routes`
- `rg "register.*Path|openApi" backend/src/app/http`
- `rg "z\\.object|validate" backend/src/app/http`

Focused checks:

- `cd backend && pnpm run test:contract`
- `cd backend && pnpm run test:integration`
- `pnpm run check:api-contracts` when public API contracts change

Related docs:

- [API Contract Workflow](../api-contract-workflow.md)
- [Architecture Extension Points](../architecture-extension-points.md)

## Application Composition

Owns default wiring for adapters, registries, capability policies, storage,
dispatchers, providers, sinks, and optional modules.

Should not own product rules. Domain behavior belongs in modules. Composition
assembles implementations.

Primary paths:

- `backend/src/app/composition/README.md`
- `backend/src/app/composition/defaultComposition.ts`
- `backend/src/app/composition/applicationModule.ts`
- `backend/src/app/composition/builtIn/`
- `backend/src/modules/*/composition.ts`

Useful searches:

- `rg "register|create.*Composition|Capability" backend/src/app/composition backend/src/modules`
- `rg "composition" backend/tests backend/src`

Focused checks:

- `cd backend && pnpm run build`
- `cd backend && pnpm run test:composition`

Related docs:

- [Architecture Extension Points](../architecture-extension-points.md)

## Documents And Ingestion

Owns document records, source content, upload/import orchestration, storage
ports, processing jobs, worker execution, and search history support.

Should not own retrieval ranking policy, assistant persona, or frontend
presentation rules.

Public surfaces and contracts:

- `backend/src/modules/documents/README.md`
- `backend/src/modules/documents/contracts/`
- `backend/src/modules/documents/composition.ts`
- `backend/src/modules/documents/historySupport.ts`

Primary internals:

- `backend/src/modules/documents/services/documentIngestionService.ts`
- `backend/src/modules/documents/services/documentProcessingService.ts`
- `backend/src/modules/documents/services/documentProcessingWorker.ts`
- `backend/src/modules/documents/services/documentJobMessage.ts`
- `backend/src/modules/documents/infra/`

Useful searches:

- `rg "DocumentJob|document job|available_at" backend/src backend/tests specs docs`
- `rg "documentProcessing|documentIngestion|DocumentStorage" backend/src`
- `rg "externalDocumentId|source" backend/src/modules/documents backend/src/app/http/routes`

Focused checks:

- `cd backend && pnpm test -- tests/unit/document-ingestion.test.ts tests/unit/document-processing-worker-runtime.test.ts tests/unit/document-import-service.test.ts`
- `cd backend && pnpm run test:integration`

Related docs and specs:

- [Document Processing Lifecycle](../../docs-portal/content/architecture/document-processing-lifecycle.mdx)
- [Website Crawler Provider](../website-crawler.md)
- `specs/012-async-document-processing/`
- `specs/055-message-queue-support/`
- `specs/024-ingestion-settings/`

## Retrieval

Owns query interpretation, lexical and vector candidate retrieval, metadata
scoring, reranking, context selection, prompt context assembly, diagnostics, and
retrieval answer services.

Should not own assistant persona, chat session behavior, HTTP request shape, or
document processing.

Public surfaces and contracts:

- `backend/src/modules/retrieval/README.md`
- `backend/src/modules/retrieval/public.ts`
- `backend/src/modules/retrieval/composition.ts`
- `backend/src/modules/retrieval/llmAdapters.ts`
- `backend/src/modules/retrieval/domain/`

Primary internals:

- `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- `backend/src/modules/retrieval/services/retrievalSearchService.ts`
- `backend/src/modules/retrieval/services/retrievalAnswerService.ts`
- `backend/src/modules/retrieval/infra/vectorSearch.ts`
- `backend/src/modules/retrieval/infra/lexicalSearch.ts`

Useful searches:

- `rg "RetrievalPipeline|retrievalPipeline|RetrievalStage" backend/src backend/tests`
- `rg "queryRewrite|rerank|metadataRule|lexical" backend/src/modules/retrieval`
- `rg "from ['\\\"]\\.\\./retrieval|modules/retrieval" backend/src`

Focused checks:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts tests/unit/retrieval-shape-resolver.test.ts tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm run test:integration`

Related docs and specs:

- [Vector Search Indexing](./vector-search-indexing.md)
- [Retrieval Pipeline](../../docs-portal/content/architecture/retrieval-pipeline.mdx)
- [Retrieval Tuning](../../docs-portal/content/guides/retrieval-tuning.mdx)
- `specs/058-retrieval-module-boundaries/`
- `specs/060-retrieval-strategy-diagnostics/`
- `specs/009-hybrid-retrieval/`
- `specs/032-split-rewrite-queries/`

## Chat And Assistant

Owns assistant chat orchestration, session preparation, history presentation,
chat streaming contracts, suggestions, citations, skill intake, and answer
presentation.

Should not own retrieval ranking, document persistence, provider registration
details, or hard-coded user-facing assistant responses.

Public surfaces and contracts:

- `backend/src/modules/chat/README.md`
- `backend/src/modules/chat/contracts/`
- `backend/src/modules/chat/composition.ts`
- `backend/src/modules/chat/llmAdapters.ts`
- `backend/src/modules/chat/retrievalSupport.ts`

Primary internals:

- `backend/src/modules/chat/services/assistantChatService.ts`
- `backend/src/modules/chat/services/chatService.ts`
- `backend/src/modules/chat/services/chatSessionPreparer.ts`
- `backend/src/modules/chat/services/chatTurnLifecycle.ts`
- `backend/src/modules/chat/services/groundedAnswerPromptComposer.ts`
- `backend/prompts/`

Useful searches:

- `rg "AssistantChat|chatService|chatTurn" backend/src backend/tests`
- `rg "citation|suggestion|skill intake|stream" backend/src/modules/chat frontend`
- `rg "backend/prompts|prompt" backend/src/modules/chat backend/src/modules/retrieval`

Focused checks:

- `cd backend && pnpm test -- tests/unit/chat-service-streaming.test.ts tests/unit/chat-history-service.test.ts tests/unit/chat-presenter.test.ts`
- `cd frontend && pnpm test -- tests/unit/chat-message-thread.test.tsx tests/unit/chat-citations.test.tsx`
- `cd frontend && pnpm run test:e2e -- assistant-history.spec.ts assistant-retrieval-settings.spec.ts`

Related docs and specs:

- [Assistant Execution Model](../assistant-execution-model.md)
- `specs/051-assistant-retrieval-boundary/`
- `specs/044-async-chat-jobs/`
- `specs/040-website-embed-widget/`
- `specs/050-social-turn-intent/`

## Settings

Owns settings validation, settings DTOs, provider ports, retrieval and ingestion
setting persistence, and settings documentation sources used by the product UI.

Should not own the runtime retrieval or ingestion implementation details beyond
typed settings contracts.

Primary paths:

- `backend/src/modules/settings/contracts/`
- `backend/src/modules/settings/domain/`
- `backend/src/modules/settings/services/`
- `backend/src/app/http/routes/settingsRoutes.ts`
- `backend/src/app/http/routes/settingsRouteSchemas.ts`
- `docs/settings-docs/`
- `frontend/docs/settings-docs/`

Useful searches:

- `rg "RetrievalSettings|IngestionSettings|settings" backend/src/modules/settings backend/src/app/http/routes`
- `rg "settings-docs" docs frontend`

Focused checks:

- `cd backend && pnpm test -- tests/unit/settings-services.test.ts tests/unit/retrieval-settings-and-chunking.test.ts tests/contract/settings.contract.test.ts`
- `cd frontend && pnpm test -- tests/unit/settings-tab-metadata.test.ts`

Related docs and specs:

- [TypeScript SDK Retrieval Settings](../typescript-sdk-retrieval-settings.md)
- `specs/024-ingestion-settings/`
- `specs/032-split-rewrite-queries/`
- `specs/043-settings-ui-refresh/`

## Auth, Accounts, And Workspaces

Owns sessions, token roles, account users, workspace routes, workspace-scoped
permissions, and authentication middleware contracts.

Should not own feature-specific business behavior. Feature code should consume
stable identity, workspace, and permission helpers.

Public surfaces and contracts:

- `backend/src/modules/account/public.ts`
- `backend/src/modules/workspace/public.ts`
- `backend/src/modules/auth/contracts/`
- `backend/src/app/http/middleware/requireSession.ts`
- `backend/src/app/http/middleware/requirePermission.ts`
- `backend/src/app/http/middleware/requireWorkspaceSession.ts`

Useful searches:

- `rg "requireSession|requirePermission|workspace" backend/src/app/http backend/src/modules`
- `rg "role token|workspace route|account user|session" backend/src backend/tests specs`

Focused checks:

- `cd backend && pnpm test -- tests/unit/auth-service.test.ts tests/unit/workspace-service.test.ts tests/integration/auth.integration.test.ts`
- `cd frontend && pnpm test -- tests/unit/auth-api.test.ts tests/unit/workspace-api-auth.test.ts tests/unit/account-api.test.ts`

Related specs:

- `specs/014-multi-workspace/`
- `specs/036-account-users/`
- `specs/049-workspace-route-keys/`
- `specs/062-multiple-role-tokens/`

## Frontend Dashboard And Public Chat

Owns dashboard views, frontend API adapters, auth and workspace contexts,
visible chat behavior, embedded chat frame, and frontend routing.

Should not duplicate backend domain rules. Frontend code should use typed API
adapters and keep tests focused on user behavior, state transitions, and data
mapping.

Primary paths:

- `frontend/components/dashboard/README.md`
- `frontend/app/`
- `frontend/components/dashboard/`
- `frontend/components/chat/`
- `frontend/components/auth/`
- `frontend/lib/api-*.ts`
- `frontend/lib/*context*.tsx`
- `frontend/tests/unit/`
- `frontend/tests/e2e/`

Useful searches:

- `rg "api[A-Z]|fetchJson|workspace" frontend/lib frontend/components`
- `rg "Chat|citation|embed|public chat" frontend/components frontend/tests`
- `rg "settings|retrieval|document" frontend/components/dashboard frontend/lib frontend/tests`

Frontend adapter and state helper brief:

- `frontend/lib/README.md`

Focused checks:

- `cd frontend && pnpm test`
- `cd frontend && pnpm run lint`
- `cd frontend && pnpm run test:e2e`

Related docs and specs:

- `frontend/README.md`
- `specs/040-website-embed-widget/`
- `specs/008-document-list-polish/`
- `specs/043-settings-ui-refresh/`
- `specs/033-dashboard-deep-links/`

## MCP Server Package

Owns the standalone MCP server package, MCP transport, read/write tool
contracts, auth exchange helpers, policy, audit behavior, and package smoke
tests.

Should not own backend product behavior. It should call backend APIs through
its adapter and generated or shared contracts.

Primary paths:

- `packages/radioso-mcp-server/src/README.md`
- `packages/radioso-mcp-server/src/`
- `packages/radioso-mcp-server/scripts/`
- `packages/radioso-mcp-server/testing/`
- `packages/radioso-mcp-server/tests/`

Useful searches:

- `rg "tool|transport|auth|audit|policy" packages/radioso-mcp-server`
- `rg "MCP|mcp" docs docs-portal/content specs packages/radioso-mcp-server`

Focused checks:

- `cd packages/radioso-mcp-server && pnpm run build`
- `cd packages/radioso-mcp-server && pnpm test`
- `cd packages/radioso-mcp-server && pnpm run smoke:all`

Related docs and specs:

- [MCP Client Setup](../mcp-client-setup.md)
- `packages/radioso-mcp-server/README.md`
- `specs/043-mcp-context-server/`
- `specs/061-mcp-deployment-modes/`

## TypeScript SDK

Owns the first-party TypeScript client surface, generated or synchronized API
types, and SDK package tests.

Should not define backend behavior. Backend contract changes should flow through
the API contract workflow.

Primary paths:

- `typescript-sdk/src/README.md`
- `typescript-sdk/src/`
- `typescript-sdk/README.md`
- `docs/typescript-sdk-getting-started.md`
- `docs/typescript-sdk-basic-usage.md`
- `docs/typescript-sdk-retrieval-settings.md`
- `docs-portal/content/sdk/`

Useful searches:

- `rg "export|class|interface" typescript-sdk/src`
- `rg "typescript-sdk|SDK" docs docs-portal/content specs`

Focused checks:

- `cd typescript-sdk && pnpm run sync`
- `cd typescript-sdk && pnpm run build`
- `cd typescript-sdk && pnpm test`

Related docs and specs:

- [API Contract Workflow](../api-contract-workflow.md)
- `specs/022-typescript-sdk-repo/`

## Docs Portal And Product Docs

Owns published docs, operator guides, SDK guides, architecture pages, and
settings documentation that appears in product surfaces.

Before editing `readme.md`, `docs/`, `docs-portal/content/`, or settings docs,
read [Document Writer Prompt](../document-writer-prompt.md).

Primary paths:

- `docs/`
- `docs-portal/content/`
- `docs/settings-docs/`
- `frontend/docs/settings-docs/`
- `readme.md`

Useful searches:

- `rg "term or endpoint" docs docs-portal/content readme.md`
- `rg "setting-key|operator concept" docs/settings-docs frontend/docs/settings-docs backend/src`

Focused checks:

- `cd docs-portal && pnpm run build`
- `cd docs-portal && pnpm run lint`

## Enterprise Edition

Owns commercial packages, Enterprise-specific runtime behavior, licensing, and
host-service local runtime paths.

Should keep optional behavior behind extension points. Default OSS composition
must continue to build without Enterprise packages.

Primary paths:

- `ee/`
- `backend/src/app/composition/`
- relevant `backend/src/modules/*/composition.ts` files

Useful searches:

- `rg "Enterprise|edition|license|capability" ee backend/src frontend`
- `rg "extension|capability policy|composition" ee backend/src/app/composition backend/src/modules`

Focused checks:

- `./run-ee-dev.sh` for local Enterprise runtime
- `cd ee && pnpm run build`
- `cd ee && pnpm test`

Related docs and specs:

- `ee/readme.md`
- [Architecture Extension Points](../architecture-extension-points.md)
- `specs/058-ee-feature-architecture/`
- `specs/063-enterprise-usage-metering/`
