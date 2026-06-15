# Implementation Plan: Workspace Email Connections and Skills

**Branch**: `email-skill-exposure` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/089-workspace-email-skills/spec.md`

> The Speckit setup script was not used because the current Conductor branch is intentionally named `email-skill-exposure`, not `089-*`. Do not rename the branch.

## Summary

Add customer-owned workspace email connections and expose them as constrained agent skills. Radioso-owned transactional email remains in `backend/src/modules/mail/`; customer email gets a separate connection/domain module backed by a reusable OAuth substrate. The MCP OAuth work from `origin/087-external-skills-oauth` (`c7de743a6`) has been merged into this workspace; implementation should extract the provider-neutral lifecycle pieces from local `backend/src/modules/externalSkills/oauth/` before building email-specific provider adapters.

Technical approach: establish a reusable OAuth connection/token lifecycle port, add a customer email connection module that consumes that port, add provider adapter ports for `createDraft` and `sendMessage`, persist email skill definitions as agent-visible allowlisted actions, and register an email skill executor through the existing `SkillExecutorPort`/routine dispatch spine. Frontend adds workspace connection setup, agent email skill authoring, and routine outcome mapping.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend); TypeScript 5.7 / React 19 / Next.js 16 (frontend)  
**Primary Dependencies**: Express, Zod, Pino, existing field encryption, existing skill/routine packages, OAuth protocol helpers from `backend/src/modules/externalSkills/oauth/` on the MCP OAuth branch or a shared extraction; first mail provider SDK/client selected during implementation planning  
**Storage**: PostgreSQL relational tables for OAuth connections/token sets, customer email connections, email skill definitions, and sanitized activity records; encrypted credential columns via existing `fieldEncryption.ts` / `CONNECTOR_ENCRYPTION_KEY` convention  
**Testing**: Vitest for backend unit/integration/contract tests; Supertest for HTTP routes; Playwright for connection setup and skill authoring UI; mock OAuth provider and mock email provider fixtures  
**Target Platform**: Linux server backend/worker and browser dashboard  
**Project Type**: Web monorepo with backend + frontend + shared packages  
**Performance Goals**: OAuth credential lookup/refresh bounded by provider timeout; email draft/send call bounded by timeout and mapped to typed skill outcomes; no indefinite routine blocking  
**Constraints**: OAuth-first, no duplicate OAuth implementation if MCP OAuth exists, no full inbox sync, no attachments in initial slice, no raw provider APIs exposed to the model, no raw secrets or message bodies in logs/traces by default  
**Scale/Scope**: One reusable OAuth substrate, one customer email connection surface, one real provider plus mock providers, agent-level email skills over workspace connections, routine invocation with typed outcomes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ✅ Spec exists and is approved; implementation stays gated until planning/tasks are complete.
- ✅ Backend work will follow TDD: OAuth lifecycle, connection services, repositories, skill executor, routes, and provider adapters require failing tests before implementation.
- ✅ Frontend user-visible behavior is planned for Playwright; frontend unit tests are limited to API adapters and non-visual state transforms.
- ✅ Stack remains Node.js backend and React frontend.
- ✅ Database remains PostgreSQL with `pgvector` available; this feature adds relational records only.
- ✅ LLM provider remains GPT-5.2 default if model-assisted field extraction/classification is added. The core OAuth/email skill path does not require an LLM.
- ✅ Secrets/keys use encrypted storage and `.env.example` updates for OAuth provider config.
- ✅ Customer data protection addressed through allowlisted skills, scoped credentials, typed validation, sanitized audit/activity, and no default body retention.
- ✅ Module boundaries are explicit: OAuth lifecycle, customer email domain, provider adapters, skill execution, transport, and composition are separate.
- ✅ Responsibility-limited files are identified below; existing mail, chat, routine engine, and route handlers do not absorb provider logic.
- ✅ App-wide adapters/registries require `backend/src/app/composition/` wiring; domain rules stay in modules.
- ✅ HTTP contracts go through code-first OpenAPI registration; generated OpenAPI artifacts are not hand-edited.
- ✅ Message-queue impact review included. Expected: no document worker/AMQP changes in first slice.
- ✅ Docs parity planned for setup, OAuth, skill authoring, routine outcomes, and transactional-vs-customer email boundary.

**Gate result: PASS**. No complexity tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/089-workspace-email-skills/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── endpoints.md
└── tasks.md              # next phase, not created by this plan pass
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── integrationOauth/       # reusable OAuth lifecycle, or extracted MCP OAuth substrate
│   │   ├── customerEmail/          # customer-owned email connections, skill defs, provider ports
│   │   ├── externalSkills/         # MCP OAuth source/reuse target; remains MCP-specific above shared OAuth
│   │   ├── mail/                   # existing Radioso transactional mail; unchanged as system mail owner
│   │   ├── routines/               # existing routine skill dispatch; no provider logic
│   │   └── skills/                 # catalog/executor registration types
│   ├── db/
│   │   └── migrations/             # OAuth/email connection + skill/activity tables
│   ├── app/
│   │   ├── http/routes/            # thin routes for OAuth/email connections and email skills
│   │   ├── http/openapi/           # code-first OpenAPI additions
│   │   └── composition/            # default OAuth/email provider and executor wiring
│   └── shared/infra/crypto/        # reuse field encryption
└── tests/
    ├── unit/
    ├── integration/
    └── contract/

frontend/
├── components/dashboard/settings/  # workspace email connections + agent email skills UI
├── lib/                            # API adapters and non-visual transforms
└── tests/                          # unit + Playwright coverage
```

**Structure Decision**: Use a new customer email module rather than extending `modules/mail`. Use a provider-neutral OAuth module or extraction that MCP and customer email can share. Register email skill execution through the existing skill executor registry so routines stay provider-agnostic.

## Module Ownership & Seams

- **Transport Layer**: New backend routes for OAuth authorization start/callback/status, customer email connection CRUD/status, email skill CRUD, and activity list. Routes authenticate/authorize, validate DTOs, and call services only.
- **Orchestration Layer**: Customer email connection service coordinates OAuth credential access, provider health/status, disable/delete rules, and audit. Email skill executor coordinates definition lookup, input merge/validation, provider draft/send call, and outcome mapping.
- **Domain Layer**: OAuth connection state model, customer email connection status, email skill definition validation, draft/send request shape, and typed outcome mapping. No provider SDK imports in domain.
- **Persistence/Integration Layer**: Repositories for OAuth connections, email connections, email skill definitions, and activity records. Provider adapters implement narrow mail ports and consume usable OAuth credentials from the shared OAuth service.
- **Application Composition**: `backend/src/app/composition/` wires default OAuth provider registry, customer email provider registry, repositories, activity sink, and email skill executor registration. Product rules remain in modules.
- **Files Kept Small**: `backend/src/modules/mail/*` must not become customer email. `backend/src/app/http/routes/*` stay transport-only. `packages/conversation-engine/*`, `packages/conversation-contract/*`, and routine runtime code stay provider/OAuth-free.
- **Planned Extractions**: Reusable OAuth lifecycle service/port from MCP OAuth if the landed implementation is currently MCP-specific; customer email provider adapter port; email skill definition repository; email skill executor; sanitized activity mapper.
- **Required Refactor Stories**: Before email implementation, inspect landed MCP OAuth. If it is embedded in `externalSkills`, first extract shared OAuth lifecycle into a neutral module with tests, then adapt MCP to consume it.

## Complexity Tracking

> No constitution violations requiring justification.

## Phase Plan

1. **OAuth substrate alignment**: extract reusable authorization/callback/refresh/status/token storage from the local MCP OAuth implementation in `backend/src/modules/externalSkills/oauth/`, then adapt MCP to consume the extracted port.
2. **Customer email connection**: add workspace email connection records, provider identity, status, disable/reauthorize/delete rules, and mock provider health.
3. **Email skill definitions**: add agent-visible email skill schema, bound/exposed field validation, draft/send mode, and references to workspace email connections.
4. **Runtime executor**: register email skill executor behind `SkillExecutorPort`; map draft/send/missing-input/disabled/needs-reauth/provider-rejected outcomes.
5. **UI and docs**: add workspace connection setup, agent email skill builder, routine mapping, activity view, and docs.

## Post-Design Constitution Check

- ✅ Design preserves the transactional/customer email split.
- ✅ Design requires OAuth reuse/extraction before email-specific OAuth logic.
- ✅ Design routes runtime execution through the existing skill/routine spine.
- ✅ API, docs, secrets, observability, and message-queue impacts are identified.
