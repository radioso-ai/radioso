---
title: "Code Map"
description: "Navigation map from product areas to public surfaces, owners, tests, and related docs for focused feature work."
last_updated: 2026-08-05
---

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

## Persistence And Data Access

Owns the Postgres implementations of persistence ports: queries, row→record mapping,
migrations, and the generated schema snapshot. Data access goes through **Kysely** (the
typed query builder) on the shared `pg.Pool`; Postgres-specific fragments live in
`shared/infra/kysely/sqlHelpers.ts`, and the `DB` type is generated from the migrations
(`pnpm run db:types`). Raw `pg` SQL is confined to a small allowlist — the migration runner,
the `Database` pool wrapper, the pgvector/full-text adapters, and the connector files bound to
the published `@radioso/connector-api` contract — enforced by `pnpm run lint:no-raw-sql`
(`scripts/checkNoRawSql.mjs`). Migrations themselves stay raw `.sql`.

Should not own product rules. Domain modules depend on a `*RepositoryPort` (a
type) and never import `pg`, Kysely, the `Database` class, or a concrete repository.

Primary paths:

- `backend/src/db/repositories/README.md` — start here; worked example for adding
  an entity (migration → port → row mapper → repository → composition wiring)
- `backend/src/db/repositories/` — repository adapters and row mappers
- `backend/src/db/migrations/` — schema; system of record, applied in order
- `backend/src/db/schema.sql` — generated read-only snapshot of the full schema
- `backend/src/shared/infra/database.ts` — the pg Pool wrapper; exposes `.kysely` (the
  shared `Kysely<DB>`) plus the legacy `query`/`queryOne`/`withTransaction` used by the
  migration runner and allowlisted raw-SQL adapters
- `backend/src/shared/infra/kysely/` — `kyselyDatabase.ts` (builds Kysely on the pool),
  generated `schema.ts` (the `DB` type), and `sqlHelpers.ts` (the only home for
  Postgres-specific fragments: pgvector, jsonb, `now()`, etc.)
- `backend/src/app/server/dependencyBuilders.ts` — where repositories are wired (`database.kysely`)

Useful searches:

- `rg "implements .*RepositoryPort" backend/src/db/repositories`
- `rg "new .*Repository\(database.kysely" backend/src/app/server/dependencyBuilders.ts`

Focused checks:

- `cd backend && pnpm run db:schema:check` (drift gate; runs in CI + `ci:local`, needs Docker)

## Customer Email

Owns workspace customer email connections backed by authorized OAuth
credentials. It does not own Radioso transactional email; password reset and
email verification stay in `backend/src/modules/mail/` and auth services.

Public surfaces and contracts:

- `backend/src/modules/customerEmail/public.ts`
- `backend/src/modules/customerEmail/domain.ts`
- `backend/src/modules/customerEmail/services/customerEmailConnectionService.ts`
- `backend/src/db/repositories/customerEmailConnectionRepository.ts`
- `backend/src/app/http/routes/customerEmailConnectionRoutes.ts`
- `backend/src/app/http/openapi/paths/customerEmailPaths.ts`

Useful searches:

- `rg "CustomerEmail|customerEmail|email-connections" backend/src frontend`
- `rg "oauth-connections" backend/src/app/http frontend/lib/api-customer-email.ts`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/customerEmail/customer-email-connection-service.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/customerEmail/customer-email-connection-repository.test.ts`
- `cd backend && pnpm exec vitest run tests/contract/customer-email-connections.contract.test.ts`

Related docs:

- [Customer Email Connections](../customer-email-skills.md)

## Slack Channel

Owns Slack app installation, the inbound Slack Events API connector, Slack
conversation mapping, generated self-host manifests, and Slack outbound posts
used by channel escalation and Slack skills.

Should not own assistant turn behavior, retrieval behavior, or routine
selection. Slack enters the chat path as `sourceChannel: "slack"` and uses the
shared Slack Web API client for posts.

Public surfaces and key files:

- `backend/src/app/http/routes/slackConnectionRoutes.ts`
- `backend/src/app/http/openapi/paths/slackPaths.ts`
- `backend/src/modules/slack/public.ts`
- `backend/src/modules/slack/manifest/slackManifest.ts`
- `backend/src/modules/connectors/plugins/slack/`
- `frontend/lib/api-slack.ts`
- `frontend/components/dashboard/settings/slack-channel-card.tsx`

Useful searches:

- `rg "slack/manifest|slack/install|slack/binding" backend/src frontend`
- `rg "app_mention|message.im|slack_conversation_links" backend/src backend/tests`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/slack tests/contract/slack-admin.contract.test.ts tests/contract/slack-webhook.contract.test.ts tests/integration/slack`
- `cd frontend && pnpm exec vitest run tests/unit/api-slack.test.ts`
- `cd frontend && pnpm exec playwright test tests/e2e/slack-channel.spec.ts`

Related docs:

- [Slack Channel](../slack-channel.md)
- [Slack Skills](../slack-skills.md)
- `specs/092-slack-channel/`

## Agent Skill Definitions (shared spine)

External MCP skills (`externalSkills`), customer email skills (`customerEmail`),
webhook skills (`webhookSkills`), and Slack skills (`slackSkills`) share one persistence spine: `agent_skills`
holds the common columns, a single `@mention` namespace per agent enforced
**across kinds**, generic `target_type` / `target_id` references, and a JSON
`config` object. Database triggers enforce the current target references for MCP
connections, customer email connections, and webhook destinations. Each module's
repository port and record shape own kind-specific config validation, so future
config-backed skill kinds should not add a table or migration unless they need
genuinely relational state outside the shared skill definition.

OAuth connection/token lifecycle is provider-neutral in `integrationOauth` and is
consumed by both MCP and customer email.

Public surfaces and key files:

- `backend/src/modules/agentSkills/public.ts` (spine vocabulary + shared type)
- `backend/src/modules/integrationOauth/public.ts` (OAuth lifecycle)
- `backend/src/db/repositories/externalSkillDefinitionRepository.ts`, `emailSkillDefinitionRepository.ts`, `webhookSkillDefinitionRepository.ts`, and `backend/src/modules/slackSkills/repository.ts`
- `backend/src/db/migrations/099_agent_skills_spine.sql`, `100_email_skills_into_spine.sql`, `101_agent_skills_generic_targets.sql`

Focused checks (real Postgres via `INTEGRATION_DATABASE_URL`):

- `cd backend && pnpm exec vitest run tests/integration/externalSkills/repositories.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/customerEmail/email-skill-definition-repository.test.ts`

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
trace events, renderer outputs, streaming deltas/finals, clarification contracts,
and the `ConversationEngine` port.

Should not own Radioso product behavior. It must not import backend modules,
database repositories, HTTP types, retrieval internals, workspace/auth modules,
or frontend presenters. Radioso-specific chat, retrieval, persistence, billing,
and dashboard settings adapt into these contracts at composition time.

Public surfaces and contracts:

- `packages/conversation-contract/index.d.ts`

Useful searches:

- `rg "ConversationEngine|ProcessTurnInput|ProcessTurnStreamInput|TurnOutcome|SelectionDecision|Clarification" packages/conversation-contract backend/src`
- `rg "@radioso/conversation-contract" .`

Focused checks:

- `pnpm --filter @radioso/conversation-contract run typecheck`

Related docs and specs:

- `specs/068-capability-neutral-turn-spine/`
- Issue `#482`

## Conversation Engine Runtime

Owns the product-independent turn loop implementation over the conversation
contracts: load history, match directives, select skills, dispatch skills, merge
steering, resolve or ask clarification, compose or stream the response, append
events, and return a unified trace.

Should not own Radioso product behavior. It may depend on
`@radioso/conversation-contract`, but it must not import backend modules,
retrieval internals, database repositories, HTTP types, workspace/auth modules,
frontend presenters, or other Radioso implementation packages.

Public surfaces and contracts:

- `packages/conversation-engine/src/index.ts`
- `packages/conversation-engine/src/clarification.ts` (generic decision,
  pending-resolution helper, and trace-stage builder; no routine or retrieval
  payload interpretation)

Useful searches:

- `rg "DefaultConversationEngine|createConversationEngine|processTurn|processTurnStream|clarification" packages/conversation-engine backend/src`
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
- `backend/src/modules/retrieval/services/senseGroupingService.ts` (conversational
  retrieval sense candidates and document-scope payload helpers)
- `backend/src/modules/retrieval/services/agenticRetrievalPipelineService.ts`
- `backend/src/modules/retrieval/services/agenticRetrievalRunner.ts`
- `backend/src/modules/retrieval/services/agenticTools/`
- `backend/src/modules/retrieval/services/retrievalSearchService.ts`
- `backend/src/modules/retrieval/services/retrievalAnswerService.ts`
- `backend/src/modules/retrieval/infra/vectorSearch.ts`
- `backend/src/modules/retrieval/infra/lexicalSearch.ts`

Useful searches:

- `rg "RetrievalPipeline|retrievalPipeline|RetrievalStage|documentScope|SenseGrouping" backend/src backend/tests`
- `rg "AgenticRetrieval|agentic|pipelineMode|RetrievalDefaultsProvider|skillSettings" backend/src/modules/retrieval backend/src/app/composition backend/tests`
- `rg "queryRewrite|rerank|metadataRule|lexical" backend/src/modules/retrieval`
- `rg "from ['\\\"]\\.\\./retrieval|modules/retrieval" backend/src`

Focused checks:

- `cd backend && pnpm test -- tests/unit/retrieval-pipeline-stages.test.ts tests/unit/retrieval-shape-resolver.test.ts tests/unit/hybrid-retrieval-search.test.ts`
- `cd backend && pnpm test -- tests/unit/sense-grouping-service.test.ts tests/unit/retrieval-sense-clarification.test.ts`
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

Owns assistant chat orchestration, turn routing, session preparation, history
presentation, chat streaming contracts, suggestions, citations, skill intake,
and answer presentation.

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
- `backend/src/modules/chat/services/turnRouter.ts`
- `backend/src/modules/chat/services/chatTurnLifecycle.ts`
- `backend/src/modules/chat/services/clarification/` (host adapter for pending
  clarification resolution, deferred commit, and metrics)
- `backend/src/modules/chat/services/directTurnSkill.ts`
- `backend/src/modules/chat/services/groundedAnswerPromptComposer.ts`
- `backend/src/modules/chat/services/summary/conversationSummaryService.ts` (rolling
  per-conversation summary #866: regenerated post-turn, injected into interpretation
  and answer prompts; state in `conversation_summaries`)
- `backend/prompts/`

Useful searches:

- `rg "AssistantChat|chatService|chatTurn" backend/src backend/tests`
- `rg "clarification|pending clarification|clarification_decisions_total" backend/src backend/tests`
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
- `packages/routine-definition` (shared definition schemas and types)
- `packages/routine-markdown` (portable markdown parser, serializer, and chip-document mapping)
- `backend/src/app/http/routes/agentRoutes.ts` (`/api/v1/agents/:agentId/routines` CRUD/validate/publish/revise/archive/restore and portable markdown sub-resources)
- `packages/conversation-contract/index.d.ts` (the `Routine` graph and guards the compiler targets)
- `packages/conversation-defaults/src/routineRegistry.ts` (ranked one-call
  activation over registered `{ routine, trigger: { description, priority } }`
  metadata)

Primary internals:

- `backend/src/modules/routines/compiler.ts`, `validator.ts`, `domain.ts`, `service.ts`
- `backend/src/db/repositories/routineDefinitionRepository.ts`, migrations `084`–`090`
- `backend/src/app/composition/routineDefinitionSource.ts` (loads + compiles published routines for activation and pinned non-published routines for resume)
- `packages/conversation-engine/src/routineRunner.ts` (runtime: activation, resume, guards, fast-forward)
- `backend/prompts/chat/routine-next-step.md`, `routine-step-reply.md`, `routine-ranked-activation.md`
- `frontend/components/dashboard/settings/assistant-routines-section.tsx` (authoring UI)

Focused checks:

- `cd backend && pnpm test -- tests/unit/routine-definition-domain.test.ts tests/unit/routine-definition-service.test.ts tests/integration/chat.integration.test.ts`
- `cd packages/conversation-engine && pnpm test`

Related docs and specs:

- [Conversational Routines](conversational-routines.md), [Authoring routines](../authoring-routines.md), [Portable Routine Markdown](../portable-routine-markdown.md), [Portable Routines API](../portable-routines-api.md)
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

## Answer Quality And Triage

Owns the operator's view of answer quality: which assistant turns are worth
reviewing, the structured triage decision an operator assigns them, and the
rates those turns aggregate to. Signal meaning is derived from skill-catalog
metadata rather than outcome-name matching.

Should not own anything that influences a turn. Nothing here feeds retrieval,
routing, or answer composition. Current triage and its append-only transition
history are its only writes. Eval verification enters through a narrow batch
port; Quality does not read Eval tables or snapshots itself.

`GET /quality/turns` and `GET /quality/stats` select from one shared turn
population, defined in `turnPopulationSql.ts`. It excludes operator-test channels
and human-authored takeover replies, so a signal's count always matches the rows
behind it. This is distinct from the offline eval suite below, which measures
conversation behavior rather than triaging production turns.

Public surfaces and contracts:

- `backend/src/modules/quality/README.md`
- `backend/src/modules/quality/composition.ts`
- `backend/src/modules/quality/contracts/`
- `backend/src/modules/quality/domain/qualitySignals.ts`
- `backend/src/modules/quality/domain/resolution.ts`
- `backend/src/modules/quality/triageStore.ts`
- `backend/src/modules/quality/turnPopulationSql.ts`

Useful searches:

- `rg "quality/turns|quality/stats|QualitySignalId|groundedAnswer" backend/src frontend`
- `rg "triage|resolutionReason|assistant_answer_triage|assistant_answer_feedback" backend/src frontend`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/quality-*.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/quality-*.integration.test.ts`

Related docs:

- `docs/human-takeover.md` (Activity tabs and the operator console)
- `docs/quality-eval-learning-loop.md` (structured closure and Eval verification)

## Audience Pulse

Owns the saved 30-day dashboard analysis that groups recurring conversation
topics, identifies recurring content gaps from grounding evidence, proposes
content to write, and opens bounded evidence or a seeded document draft in the
existing dashboard surfaces. It also owns the topic census: an exact
clustering of every eligible visitor question in an analysis window into
topics, with topic identity (survived, split, merged, emerged, dissolved)
tracked across analyses so growth and decline are attributable rather than
guessed. See [Topic Census](./topic-census.md) for the full pipeline.

Should not affect chat or retrieval behavior, write Knowledge Base content,
expose a new external MCP tool, or restate the eligibility and facet-storage
rules the Chat and Facet Extraction Jobs modules already own. It reads
history and facets through narrow ports, clusters and names topics with
`@radioso/census` and the workspace's model tiers, and stores a snapshot and
census runs in Postgres.

Public surfaces and contracts:

- `backend/src/modules/audiencePulse/contracts.ts`
- `backend/src/modules/audiencePulse/contracts/topicCensus.ts` (`TopicRepositoryPort` and the run/topic/membership/transition input shapes)
- `backend/src/modules/audiencePulse/contracts/topicLabel.ts` (`TopicNamingPort`, `TopicLabelPrivacyAuditPort`)
- `backend/src/modules/audiencePulse/composition.ts`
- `backend/src/modules/audiencePulse/routes.ts` (`GET|POST /api/v1/quality/audience-pulse` and `POST /api/v1/quality/audience-pulse/evidence-anchor`)
- `frontend/components/dashboard/audience-pulse-view.tsx`
- `frontend/lib/api-audience-pulse.ts`
- `frontend/lib/audience-pulse-draft-seed.ts` and `frontend/lib/audience-pulse-evidence-handoff.ts`

Primary internals:

- `backend/src/modules/audiencePulse/services/audiencePulseService.ts`
- `backend/src/modules/audiencePulse/services/censusService.ts` (orchestrates one census run: population, facets, clustering, naming, identity matching, persistence)
- `backend/src/modules/audiencePulse/infra/censusServiceFactory.ts`, `modelTopicNamingGateway.ts`, `modelTopicLabelPrivacyAuditGateway.ts`
- `backend/src/modules/audiencePulse/services/topicLabelPrivacyAudit.ts` (regenerate-once-then-neutral-fallback privacy pass over a generated label)
- `backend/src/modules/audiencePulse/domain/censusSeed.ts`, `topicVector.ts`
- `backend/src/modules/audiencePulse/infra/audiencePulseRefreshRateLimiter.ts`
- `backend/src/modules/chat/audiencePulseHistorySource.ts`
- `backend/src/db/repositories/audiencePulseSnapshotRepository.ts`
- `backend/src/db/repositories/topicRepository.ts` (`topics`, `topic_census_runs`, `topic_memberships`, `topic_transitions`)
- `backend/src/db/migrations/135_audience_pulse_snapshots.sql`, `137_topic_census.sql`, `138_topic_transition_centroid_fallback.sql`
- `backend/prompts/audience-pulse.md`, `audience-pulse-topic-naming.md`, `audience-pulse-topic-fallback.md`, `audience-pulse-topic-audit.md`

Useful searches:

- `rg "AudiencePulse|audiencePulse|audience-pulse|TopicCensus|topic_census" backend/src frontend backend/tests`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/audiencePulse tests/integration/audiencePulse tests/contract/audiencePulse`
- `cd frontend && pnpm exec playwright test tests/e2e/audience-pulse.spec.ts`

Related specs:

- `specs/939-continuous-content-planning/`
- `specs/956-audience-topic-census/`

## Facet Extraction Jobs

Owns the async job spine that turns individual messages into stored facets for
the topic census: one durable job per message, a polling claim loop in the
worker process, the retry policy around it, and the `message_facets` store the
census reads from.

Facet extraction is batch analytics — no turn, request, or user-visible surface
waits on it — so the poll loop is the whole transport and there is no queue
dispatcher. The spine knows nothing about what a facet is: extraction arrives as
an injected port, registered through application composition. With no extractor
registered the worker is not built, so queued jobs stay durable rather than
being drained into a no-op. Eligibility for a job is decided once, at enqueue
time, by `isEligibleForFacetExtraction` in the Chat module
(`chatSessionPreparer.ts`) — the same predicate Audience Pulse reads history
with, restated as a write-time check rather than duplicated.

Public surfaces and contracts:

- `backend/src/modules/facets/contracts.ts` (`FacetExtractionPort`, `FacetExtractionJobStore`, `MessageFacetRepositoryPort`)
- `backend/src/modules/facets/composition.ts` (`createFacetExtractionWorker`)
- `registerFacetExtraction` on the application module registration context

Primary internals:

- `backend/src/modules/facets/services/facetExtractionWorker.ts`
- `backend/src/modules/facets/services/facetExtractionService.ts` (extraction on the `"rewrite"` model tier plus embedding through `ClusteringEmbeddingPort`)
- `backend/src/db/repositories/facetExtractionJobRepository.ts` (`facet_extraction_jobs`)
- `backend/src/db/repositories/messageFacetRepository.ts` (`message_facets`)
- `backend/src/db/migrations/137_topic_census.sql` (`facet_extraction_jobs`, `message_facets`)
- `backend/src/runtime/startWorkerRuntime.ts` (start/stop registration)
- `backend/scripts/dev/backfillFacetExtractionJobs.ts` (dev tool: enqueue jobs for eligible messages that predate this feature)

Operator configuration:

- `FACET_EXTRACTION_WORKER_POLL_INTERVAL_MS`, `FACET_EXTRACTION_WORKER_BATCH_SIZE`,
  `FACET_EXTRACTION_JOB_LEASE_MS`

Useful searches:

- `rg "FacetExtraction|facet_extraction|message_facets" backend/src backend/tests`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/facets`
- `cd backend && INTEGRATION_DATABASE_URL=... pnpm exec vitest run tests/integration/facets --no-file-parallelism`

Related specs:

- `specs/956-audience-topic-census/`

## Topic Census Clustering (`@radioso/census`)

Owns the pure clustering algorithms the topic census runs on: seeded k-means
over normalized vectors with a two-level base/topic hierarchy, and identity
matching that classifies each new cluster against the prior run's topics as
survived, split, merged, emerged, or dissolved.

Should not read a database, call a network, embed text, or name a cluster. It
takes `(id, text, vector)` items and prior topic memberships in, and returns
clusters, unclassified ids, and transitions out; embedding and naming are
always the caller's job (`backend/src/modules/audiencePulse`).

Public surfaces and contracts:

- `packages/census/src/index.ts` (`computeCensus`, `matchTopicIdentities`, `DEFAULT_CENSUS_OPTIONS`, `DEFAULT_TOPIC_IDENTITY_OPTIONS`)

Useful searches:

- `rg "computeCensus|matchTopicIdentities|CensusCluster|TopicTransition" packages/census backend/src`
- `rg "@radioso/census" .`

Focused checks:

- `pnpm --filter @radioso/census run typecheck`
- `pnpm --filter @radioso/census run test`

Related docs and specs:

- `docs/architecture/topic-census.md`
- `specs/956-audience-topic-census/`

## Product Eval Cases And Runs

Owns the DB-backed operator Eval surface: immutable conversation snapshots,
editable cases and assertions, recorded runs, and the stable association from
one AI-authored assistant message to one current case.

Should not decide whether a production turn needs review or mutate Quality
triage. Quality consumes only the compact case/run projection exposed through
its own verification port. The message-scoped create operation validates
authorship and replayability before its transaction creates the snapshot, case,
and association together.

Public surfaces and contracts:

- `backend/src/modules/eval/composition.ts`
- `backend/src/modules/eval/domain/types.ts`
- `backend/src/modules/eval/routes/evalRoutes.ts`
- `backend/src/modules/eval/services/evalMessageCaseService.ts`
- `backend/src/modules/eval/services/evalMessageCaseRepository.ts`
- `GET|PUT /api/v1/evals/cases/by-source-message/{assistantMessageId}`

Useful searches:

- `rg "EvalMessageCase|by-source-message|eval_message_case_associations" backend/src frontend`
- `rg "EvalSnapshot|EvalCase|EvalRun" backend/src/modules/eval`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/eval-message-case-service.test.ts tests/unit/eval-message-case-routes.test.ts tests/unit/eval-snapshot-service.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/eval-repository.integration.test.ts`

Related docs:

- `docs/quality-eval-learning-loop.md`
- `docs-portal/content/guides/evals.mdx`

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

## Conversation-Quality Eval Suite

Owns a committed, version-controlled suite that measures conversation quality:
routing, retrieval, grounding, directive steering, routine activation, and
clarification. It is separate from the DB-backed product eval harness in
`backend/src/modules/eval/`, which is an operator dashboard surface.

Should not own product behavior. It observes turns and scores them; it does not
change how turns are produced.

Two layers. A deterministic layer reads structured trace signal (route, skill,
routine, grounding verdict) plus retrieval and citation checks, and runs with no
model. A semantic layer (`llm_judge`) is reserved for properties a check cannot
express, such as empathy or refusal.

Primary paths:

- `backend/src/modules/eval/suite/` — case schema, trace assertions, scoring,
  baseline diff, sampling reducer, report
- `backend/tests/fixtures/conversation-quality/` — the dataset (corpus, seed
  routines and directives, agent, cases, `baseline.json`) and its `README.md`
- `backend/scripts/runEvals.ts` — headless CLI that seeds fixtures, drives turns
  through `WorkbenchReplayRunner`, scores, and gates on the baseline
- `.github/workflows/conversation-quality-evals.yml` — nightly live run

Full-assistant runs use the same conversation turn assembly as production chat
when the Workbench runner and a full agent-config snapshot are available.
`WorkbenchReplayRunner` supplies in-memory conversation, message, routine,
clarification, and directive state adapters, so engine behavior is exercised
without writing conversation history, audit events, actions, or decisions.
Eval-driven Workbench turns carry the eval run ID and `eval` surface through
the prepared session so retrieval and model usage remain attributed to the run.
Legacy snapshots and hosts without Workbench replay configured retain the
legacy full-assistant path. `retrieval_only` runs keep the retrieval pipeline
path because they measure retrieval independently of assistant behavior.

Useful searches:

- `rg "SuiteTraceAssertion|reduceSamples|diffAgainstBaseline" backend/src/modules/eval/suite`
- `rg "conversationQualityCases|conversationQualityRoutines" backend/tests/fixtures/conversation-quality`

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/eval-suite` — deterministic
  harness (runs in normal CI)
- `cd backend && pnpm run evals:ci` — live sampled run (needs Postgres,
  `OPENAI_API_KEY`, and a running document worker); nightly, not per-PR

Related docs:

- `backend/tests/fixtures/conversation-quality/README.md`
