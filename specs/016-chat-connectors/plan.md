# Implementation Plan: Chat Connector Plugin System

**Branch**: `016-chat-connectors` | **Date**: 2026-03-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-chat-connectors/spec.md`

## Summary

Introduce a modular connector plugin system that allows workspace administrators to bridge external messaging platforms (starting with WhatsApp) into the existing chat pipeline. The system adds a `ConnectorPlugin` interface, a `ConnectorRegistry` for lifecycle management, standardized REST endpoints for connector config, and a schema-driven Settings UI tab — all without modifying core modules (chat, retrieval, documents). The WhatsApp connector is the reference implementation using Meta's Cloud API.

## Technical Context

**Language/Version**: TypeScript / Node.js (backend), TypeScript / React + Next.js (frontend)
**Primary Dependencies**: Express.js, pg (PostgreSQL driver), Vitest (testing), Shadcn/ui (frontend components)
**Storage**: PostgreSQL with `pgvector` extension
**Testing**: Vitest with supertest for contract tests, in-memory fakes for unit tests
**Target Platform**: Linux server (backend), Web browser (frontend)
**Project Type**: Web application (backend + frontend)
**Performance Goals**: Webhook acknowledgement within 5 seconds, chat response latency on par with web chat
**Constraints**: Connectors must not modify core modules. Webhook signature verification required. Secret fields encrypted at rest.
**Scale/Scope**: Initial deployment supports single WhatsApp number per workspace. Message log retained 90 days.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec exists and is approved**: ✅ Spec at `specs/016-chat-connectors/spec.md`, clarification session complete.
- **Backend work includes TDD**: ✅ Plan includes test-first approach for all backend modules. Tests use Vitest + supertest pattern established in the project.
- **Stack remains Node.js for backend and React for frontend**: ✅ No deviations.
- **Database is PostgreSQL with pgvector**: ✅ New connector tables use PostgreSQL. Core pgvector tables untouched.
- **LLM provider is GPT-5.2**: ✅ Connectors call into `ChatService` which uses the existing LLM provider. No new LLM integration.
- **Secrets and keys managed via .env / .env.example**: ✅ Connector-level secrets (API tokens, app secrets) stored encrypted in the database (per-workspace config). Application-level encryption key added to `.env`. `.env.example` updated.
- **Customer data handling**: ✅ Webhook payloads logged in connector-specific tables with 90-day retention. Secret fields masked in API responses. HMAC signature verification prevents forged messages.
- **Module boundaries explicit**: ✅ New `connectors` module with clear separation: `ConnectorPlugin` interface (domain), `ConnectorRegistry` (orchestration), per-connector plugins (domain + persistence), connector routes (transport). Core modules unchanged.
- **Existing files kept small**: ✅ `dependencies.ts` gets one new wiring block for `ConnectorRegistry`. `routes/index.ts` gets one mount point. Settings UI gets one new tab component. No existing file absorbs significant new logic.
- **Architecture/refactor stories**: ✅ Not needed — the connector system is a new module alongside existing ones, not an expansion of existing files.

## Project Structure

### Documentation (this feature)

```text
specs/016-chat-connectors/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── connectors-api.yaml
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   └── connectors/                    # NEW module
│   │       ├── domain/
│   │       │   ├── connectorPlugin.ts     # ConnectorPlugin interface
│   │       │   ├── connectorConfig.ts     # ConnectorConfig types
│   │       │   └── configSchema.ts        # Config schema field types
│   │       ├── services/
│   │       │   ├── connectorRegistry.ts   # Registry: lifecycle, discovery, route mounting
│   │       │   └── configEncryption.ts    # Encrypt/decrypt/mask secret fields
│   │       ├── plugins/
│   │       │   └── whatsapp/
│   │       │       ├── whatsappPlugin.ts      # ConnectorPlugin implementation
│   │       │       ├── whatsappWebhook.ts     # Webhook handler (verify, receive, ack)
│   │       │       ├── whatsappClient.ts      # Cloud API client (send messages)
│   │       │       ├── whatsappMessageHandler.ts  # Debounce, process, reply orchestration
│   │       │       └── migration.sql          # WhatsApp-specific tables
│   │       └── http/
│   │           └── connectorRoutes.ts     # Standardized REST endpoints for config/status
│   ├── db/
│   │   └── migrations/
│   │       └── 007_connector_config.sql   # Core connector_configs table
│   ├── app/
│   │   ├── server/
│   │   │   ├── dependencies.ts            # MODIFIED: wire ConnectorRegistry
│   │   │   └── types.ts                   # MODIFIED: add connectorRegistry to AppDependencies
│   │   └── http/
│   │       └── routes/
│   │           └── index.ts               # MODIFIED: mount connector routes
│   └── shared/
│       └── infra/
│           └── database.ts                # EXISTING: used by connectors (no changes)
├── tests/
│   ├── unit/
│   │   └── connectors/
│   │       ├── connectorRegistry.test.ts
│   │       ├── configEncryption.test.ts
│   │       └── whatsapp/
│   │           ├── whatsappWebhook.test.ts
│   │           ├── whatsappClient.test.ts
│   │           └── whatsappMessageHandler.test.ts
│   ├── contract/
│   │   └── connectors/
│   │       └── connectorRoutes.test.ts
│   └── integration/
│       └── connectors/
│           └── whatsappFlow.test.ts

frontend/
├── components/
│   └── dashboard/
│       ├── settings-view.tsx              # MODIFIED: add "Chat Connectors" tab
│       └── connectors/                    # NEW directory
│           ├── connectors-tab.tsx         # Tab content: list of connectors
│           ├── connector-card.tsx         # Individual connector card
│           └── connector-config-form.tsx  # Schema-driven config form
├── lib/
│   └── api.ts                             # MODIFIED: add connectorsApi service
```

**Structure Decision**: The connector system lives entirely within `backend/src/modules/connectors/`, following the existing modular pattern (`chat/`, `documents/`, `retrieval/`, `settings/`). Each connector plugin (e.g. `whatsapp/`) is a subdirectory under `plugins/`. The core connector infrastructure (interface, registry, routes, encryption) sits alongside the plugins directory. Frontend additions are minimal: one new tab component with two sub-components, all schema-driven.

## Module Ownership & Seams

- **Transport Layer**: `connectorRoutes.ts` handles REST endpoints for config management. `whatsappWebhook.ts` handles WhatsApp webhook GET/POST. These translate HTTP requests but do not own business rules.
- **Orchestration Layer**: `ConnectorRegistry` coordinates plugin lifecycle (migrate, initialize, shutdown, route mounting). `whatsappMessageHandler.ts` orchestrates the debounce → ChatService → reply flow.
- **Domain Layer**: `ConnectorPlugin` interface defines the contract. `configSchema.ts` defines field types. `configEncryption.ts` handles secret encryption/masking. `whatsappPlugin.ts` implements WhatsApp-specific domain logic.
- **Persistence/Integration Layer**: `007_connector_config.sql` creates the shared `connector_configs` table. `whatsapp/migration.sql` creates WhatsApp-specific tables. `whatsappClient.ts` is the gateway to Meta's Cloud API.
- **Files Kept Small**: `dependencies.ts` — only adds `ConnectorRegistry` wiring (≈10 lines). `routes/index.ts` — only adds one `app.use()` mount (≈2 lines). `settings-view.tsx` — only adds one tab entry pointing to `connectors-tab.tsx`.
- **Planned Extractions**: `ConnectorPlugin` interface (new seam). `ConnectorRegistry` (new orchestrator). `ConnectorContext` (scoped dependency bag passed to plugins). Per-plugin config schema (declarative, rendered generically).
- **Required Refactor Stories**: None — this is a greenfield module that integrates at well-defined touch points.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
