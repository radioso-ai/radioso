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

## Shared Agent Runtime

Owns the reusable in-repo substrate for tool-calling LLM agents: the typed tool
contract, model gateway port, run loop, budget enforcement, cancellation, and
trace events.

Should not own product behavior. Retrieval, documents, chat, assistants,
persona, and response policy belong in the domain module that supplies the
tools and consumes the trace.

Public surfaces and contracts:

- `backend/src/shared/agent-runtime/README.md`
- `backend/src/shared/agent-runtime/index.ts`
- `backend/src/shared/agent-runtime/types.ts`
- `backend/src/shared/agent-runtime/defaultAgentRuntime.ts`
- `backend/src/shared/agent-runtime/textRoutedGateway.ts`

Useful searches:

- `rg "AgentRuntime|AgentTool|AgentTraceEvent" backend/src backend/tests`
- `rg "ModelToolCallingGateway|TextRoutedToolCallingGateway" backend/src backend/tests`
- `rg "createToolCallingGateway|agent-runtime" backend/src`

Focused checks:

- `cd backend && pnpm test -- tests/unit/agent-runtime.test.ts tests/unit/text-routed-tool-calling-gateway.test.ts`
- `cd backend && pnpm run lint:boundaries`

Related docs and specs:

- `specs/065-agent-runtime-and-agentic-retrieval/`

## Conversation Engine Contracts

Owns product-independent conversation runtime contracts: agents, input events,
directives, steering, skills, staged context, selection decisions, turn outcomes,
trace events, renderer outputs, streaming deltas/finals, and the
`ConversationEngine` port.

Should not own Radioso product behavior. It must not import backend modules,
database repositories, HTTP types, retrieval internals, workspace/auth modules,
or frontend presenters. Radioso-specific chat, retrieval, persistence, billing,
and dashboard settings adapt into these contracts at composition time.

Public surfaces and contracts:

- `packages/conversation-contract/index.d.ts`

Useful searches:

- `rg "ConversationEngine|ProcessTurnInput|ProcessTurnStreamInput|TurnOutcome|SelectionDecision" packages/conversation-contract backend/src`
- `rg "@radioso/conversation-contract" .`

Focused checks:

- `pnpm --filter @radioso/conversation-contract run typecheck`

Related docs and specs:

- `specs/068-capability-neutral-turn-spine/`
- Issue `#482`

## Conversation Engine Runtime

Owns the product-independent turn loop implementation over the conversation
contracts: load history, match directives, select skills, dispatch skills, merge
steering, compose or stream the response, append events, and return a unified
trace.

Should not own Radioso product behavior. It may depend on
`@radioso/conversation-contract`, but it must not import backend modules,
retrieval internals, database repositories, HTTP types, workspace/auth modules,
frontend presenters, or other Radioso implementation packages.

Public surfaces and contracts:

- `packages/conversation-engine/src/index.ts`

Useful searches:

- `rg "DefaultConversationEngine|createConversationEngine|processTurn|processTurnStream" packages/conversation-engine backend/src`
- `rg "@radioso/conversation-engine" .`

Focused checks:

- `pnpm --filter @radioso/conversation-engine run typecheck`
- `pnpm --filter @radioso/conversation-engine run test`
- `cd backend && pnpm test -- tests/unit/runtime-startup.test.ts tests/unit/runtime-config.test.ts`

Related docs and specs:

- `specs/068-capability-neutral-turn-spine/`
- Issue `#482`

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
retrieval answer services. Retrieval behavior is resolved from system defaults
and per-agent `retrieval.answer` skill settings; workspace settings do not own
retrieval configuration.

Should not own assistant persona, chat session behavior, HTTP request shape, or
document processing.

Public surfaces and contracts:

- `backend/src/modules/retrieval/README.md`
- `backend/src/modules/retrieval/public.ts`
- `backend/src/modules/retrieval/composition.ts`
- `backend/src/modules/retrieval/llmAdapters.ts`
- `backend/src/modules/retrieval/domain/`
- `backend/src/app/composition/retrievalDefaultsProvider.ts`

Primary internals:

- `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- `backend/src/modules/retrieval/services/agenticRetrievalPipelineService.ts`
- `backend/src/modules/retrieval/services/agenticRetrievalRunner.ts`
- `backend/src/modules/retrieval/services/agenticTools/`
- `backend/src/modules/retrieval/services/retrievalSearchService.ts`
- `backend/src/modules/retrieval/services/retrievalAnswerService.ts`
- `backend/src/modules/retrieval/infra/vectorSearch.ts`
- `backend/src/modules/retrieval/infra/lexicalSearch.ts`

Useful searches:

- `rg "RetrievalPipeline|retrievalPipeline|RetrievalStage" backend/src backend/tests`
- `rg "AgenticRetrieval|agentic|pipelineMode|RetrievalDefaultsProvider|skillSettings" backend/src/modules/retrieval backend/src/app/composition backend/tests`
- `rg "queryRewrite|rerank|metadataRule|lexical" backend/src/modules/retrieval`
- `rg "from ['\\\"]\\.\\./retrieval|modules/retrieval" backend/src`

Focused checks:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts tests/unit/retrieval-shape-resolver.test.ts tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm test -- tests/unit/agentic-retrieval-runner.test.ts tests/unit/agentic-retrieval-pipeline-service.test.ts tests/unit/agentic-tools.test.ts tests/unit/agentic-activity-trace-builder.test.ts tests/unit/query-rewrite-port.test.ts tests/unit/retrieval-context-stage-override.test.ts`
- `cd backend && pnpm run test:integration`

Related docs and specs:

- [Vector Search Indexing](./vector-search-indexing.md)
- [Retrieval Pipeline](../../docs-portal/content/architecture/retrieval-pipeline.mdx)
- [Agents and Skills](../../docs-portal/content/api/agents-and-skills.mdx)
- `specs/058-retrieval-module-boundaries/`
- `specs/060-retrieval-strategy-diagnostics/`
- `specs/009-hybrid-retrieval/`
- `specs/032-split-rewrite-queries/`
- `specs/065-agent-runtime-and-agentic-retrieval/`

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
- [Assistant Turn Spine](assistant-turn-spine.md)
- `specs/066-assistant-turn-loop-spine/`
- `specs/051-assistant-retrieval-boundary/`
- `specs/044-async-chat-jobs/`
- `specs/040-website-embed-widget/`
- `specs/050-social-turn-intent/`

## Directives

Owns authored, standing behavioral steering: `condition → action` rules the
assistant matches per turn and injects into answer composition. Directives steer,
they never act — no executor, no dispatch, no outputs. Distinct from Skills,
which act.

Should not depend on any other domain module (not chat, skills, or retrieval).
Chat answer turns pass route-scoped directive candidates and the configured
matcher into the conversation engine. After the engine matches directives, chat
resolves those matches through the same capability and relationship filtering
used by `DirectiveSteeringPort`. Direct retrieval surfaces still consume
`DirectiveSteeringPort` directly.

Public surfaces and contracts:

- `backend/src/modules/directives/README.md`
- `backend/src/modules/directives/public.ts`
- `backend/src/shared/domain/steeringRule.ts` (shared steering value type, also used by skills)

Primary internals:

- `backend/src/modules/directives/directiveMatcher.ts` (deterministic always-match)
- `backend/src/modules/directives/probabilisticDirectiveMatcher.ts` (LLM contextual match)
- `backend/src/modules/directives/directiveSteeringService.ts`
- `backend/src/modules/chat/services/directiveTracePresenter.ts`
- `backend/prompts/chat/steering.md`, `backend/prompts/chat/directive-match.md`

Focused checks:

- `cd backend && pnpm test -- tests/unit/directives.test.ts tests/unit/steering-rule.test.ts tests/unit/grounded-answer-steering.test.ts tests/unit/directive-trace.test.ts tests/unit/directive-probabilistic-matcher.test.ts`

Related docs and specs:

- [Conversational Directives](conversational-directives.md)
- `specs/067-conversational-directives/`
- `specs/066-assistant-turn-loop-spine/`

## Routines

Owns the authoring side of multi-step routines: the definition data model, the
compiler that turns a definition into the conversation-engine routine graph, the
validator (author-facing diagnostics), and the per-agent repository. A routine is
authored as data and published; the chat runtime loads an agent's published
routines per turn and runs them through the engine. The runtime itself —
activation, resume, guards, fast-forward, projecting a step into a directive —
lives in `packages/conversation-engine`, not here.

The engine must not import this module; it consumes the compiled `Routine` graph,
never the authoring data. Action steps fire through the conversation-action outbox
and are gated by a per-action capability.

Public surfaces and contracts:

- `backend/src/modules/routines/public.ts` (definition types, compiler, validator)
- `backend/src/app/http/routes/agentRoutes.ts` (`/api/v1/agents/:agentId/routines` CRUD/validate/publish)
- `packages/conversation-contract/index.d.ts` (the `Routine` graph and guards the compiler targets)

Primary internals:

- `backend/src/modules/routines/compiler.ts`, `validator.ts`, `domain.ts`, `service.ts`
- `backend/src/db/repositories/routineDefinitionRepository.ts`, migrations `084`–`086`
- `backend/src/app/composition/routineDefinitionSource.ts` (loads + compiles published routines per turn)
- `packages/conversation-engine/src/routineRunner.ts` (runtime: activation, resume, guards, fast-forward)
- `backend/prompts/chat/routine-next-step.md`, `routine-step-reply.md`, `routine-data-activation.md`
- `frontend/components/dashboard/settings/assistant-routines-section.tsx` (authoring UI)

Focused checks:

- `cd backend && pnpm test -- tests/unit/routine-definition-domain.test.ts tests/unit/routine-definition-service.test.ts tests/integration/chat.integration.test.ts`
- `cd packages/conversation-engine && pnpm test`

Related docs and specs:

- [Conversational Routines](conversational-routines.md), [Authoring routines](../authoring-routines.md)
- `specs/082-routines-as-data/`, `specs/069-conversation-routines/`

## Settings

Owns settings validation, settings DTOs, provider ports, ingestion setting
persistence, read-only retrieval defaults exposure, and settings documentation
sources used by the product UI.

Should not own runtime retrieval configuration, retrieval implementation
details, or ingestion implementation details beyond typed settings contracts.
Per-agent retrieval settings are stored on agents as `retrieval.answer` skill
settings. System retrieval defaults come from composition through
`RetrievalDefaultsProvider`.

Primary paths:

- `backend/src/modules/settings/contracts/`
- `backend/src/modules/settings/domain/`
- `backend/src/modules/settings/services/`
- `backend/src/app/http/routes/settingsRoutes.ts`
- `backend/src/app/http/routes/settingsRouteSchemas.ts`
- `docs/settings-docs/`
- `frontend/docs/settings-docs/`

Useful searches:

- `rg "RetrievalDefaultsProvider|IngestionSettings|settings" backend/src/modules/settings backend/src/app/http/routes backend/src/app/composition`
- `rg "settings-docs" docs frontend`

Focused checks:

- `cd backend && pnpm test -- tests/unit/settings-services.test.ts tests/unit/retrieval-context-stage-override.test.ts tests/contract/settings.contract.test.ts`
- `cd frontend && pnpm test -- tests/unit/settings-tab-metadata.test.ts`

Related docs and specs:

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
