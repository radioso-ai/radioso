# Implementation Plan: Enterprise Human Contact Handoff

**Branch**: `human-contact-intent` | **Date**: 2026-05-04 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/056-enterprise-human-contact-handoff/spec.md`

## Summary

Add an Enterprise-only human-contact handoff flow with a no-op OSS chat-action extension point, EE persistence/settings/routes, signed webhook retry delivery, contact-specific chat action suggestions, and an inline chat composer that can enact explicit visible contact requests.

## Technical Context

**Language/Version**: TypeScript on Node.js 22, React 19 with Next.js 16 App Router  
**Primary Dependencies**: Express, Zod, Pino, OpenAI SDK/provider adapters, Radix/shadcn UI, Lucide icons  
**Storage**: PostgreSQL 16 with existing migration/repository conventions  
**Testing**: Vitest, Supertest, Playwright where practical  
**Target Platform**: Self-hosted backend/frontend and Enterprise packages  
**Project Type**: Web application with backend, frontend, EE packages, embed widget, docs, and SDK contract artifacts  
**Performance Goals**: Chat response path should not synchronously deliver webhooks; submit returns after durable storage. Retry poller must process bounded batches.  
**Constraints**: Secrets never returned after save; public submissions must validate existing public sessions and rate limits; user-facing assistant copy remains LLM-generated.  
**Scale/Scope**: Workspace-scoped settings and request rows; webhook sink only for v1.

## Constitution Check

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Frontend user-visible behavior is planned for Playwright coverage where existing harness supports it.
- Stack remains Node.js for backend and React for frontend.
- Database remains PostgreSQL with `pgvector`.
- LLM provider remains GPT-5.2 for AI integrations.
- Secrets are stored through existing environment/database secret hygiene; `.env.example` is reviewed for new env needs.
- Customer data handling and auditability are addressed through durable request rows, limited payloads, redacted logs, and no full transcript in payloads.
- Module boundaries are explicit below.
- Backend HTTP contracts require code-first OpenAPI updates and generated artifact refresh.
- Message-queue impact review: this feature adds an EE outbox-style poller but does not change document worker dispatch, AMQP document payloads, or existing queue contracts. Retry behavior is local to human-contact delivery.
- Documentation updates required in EE docs, API/public chat/embed docs, and settings docs.

## Project Structure

```text
backend/
├── src/app/composition/
├── src/app/http/openapi/
├── src/app/http/routes/
├── src/app/http/schemas/
├── src/modules/chat/
├── src/modules/chat/services/chatActionProvider.ts
└── tests/

ee/
└── packages/backend-module/

frontend/
├── components/chat/
├── components/dashboard/
├── components/dashboard/settings/
└── lib/

docs/
docs-portal/
typescript-sdk/
```

**Structure Decision**: Shared OSS code owns contracts and a disabled extension point. EE code owns concrete storage/delivery/settings. Frontend owns inline composer presentation and API calls. OpenAPI and SDK artifacts are regenerated from backend contracts.

## Module Ownership & Seams

- **Transport Layer**: EE backend route modules translate authenticated and public requests into contact service calls and map errors to HTTP responses.
- **Orchestration Layer**: Human-contact services coordinate settings checks, draft generation, request persistence, outbox enqueue, and delivery scheduling.
- **Domain Layer**: Focused trigger rules, request validation, draft fallback, backoff, webhook payload construction, and HMAC signing.
- **Persistence/Integration Layer**: EE repositories store settings and requests; webhook client posts signed payloads.
- **Application Composition**: `backend/src/app/composition/` wires the disabled OSS implementation by default and accepts EE module registration for concrete implementation and worker lifecycle.
- **Files Kept Small**: Existing chat routes remain transport adapters; assistant chat services only attach action metadata and do not deliver requests; frontend chat views delegate form behavior to focused components/hooks.
- **Planned Extractions**: `backend/src/modules/chat/services/chatActionProvider.ts*`, frontend inline contact composer/API helpers, and EE backend-module concrete repositories/services.
- **Required Refactor Stories**: None identified before implementation; if existing chat components resist focused integration, extract inline contact composer behavior before wiring it into each surface.

## Complexity Tracking

No constitution violations planned.
