# Implementation Plan: Unified Skill Model

**Branch**: `094-unified-skills` | **Date**: 2026-06-22 | **Spec**: `specs/094-unified-skills/spec.md`
**Input**: Feature specification from `/specs/094-unified-skills/spec.md`; design source of truth `research.md`.

## Summary

Make every agent capability a **named skill instance of a capability type**, authored through **one** "Add new skill" form and served by **one** CRUD + capability-descriptor API, over the existing `agent_skills` spine. The load-bearing additions are: a **capability-type registry** (the single place that knows what each capability is — for both runtime resolution and authoring), an `invocation_mode` property, and bringing **retrieval** onto the spine as named instances (with the grounding answer as the `default_answer` instance). Contact→`notify` and routine-terminal webhook-export→`webhook_call` fold in last. The runtime dispatcher/executor substrate already exists and is preserved; this is substrate consolidation plus the retrieval data-model change, not a new channel.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), TypeScript 5.7 / React 19 / Next.js 16 (frontend).
**Primary Dependencies**: Express, Zod, Pino, pg/`pgvector`; conversation-engine + conversation-contract packages; existing `SkillExecutorRegistry` / `skillDispatcher` / per-kind resolvers + executors.
**Storage**: PostgreSQL 16. Existing `agent_skills` spine (migrations 099/101/108); retrieval currently in `agents.skill_settings` JSONB (074); contact/webhook-export in `assistantBehaviorSettings`.
**Testing**: Vitest (unit/integration/contract) TDD on backend; Playwright for the Skills authoring journey; Vitest for the capability-registry / form data-derivation logic only.
**Target Platform**: Self-hosted + Cloud web app.
**Project Type**: web (backend + frontend + packages).
**Performance Goals**: No added latency on the default-answer turn path (retrieval-as-skill must resolve the default instance without extra round-trips); skill-capabilities descriptor is a cheap read.
**Constraints**: Behavior-preserving migrations (retrieval/contact/webhook-export); no per-capability branching in the CRUD route or the form; `similarityThreshold` stays system-only.
**Scale/Scope**: 6 capability types, one spine, ~one CRUD module, one frontend form + list; 4 slices (F0 + US1–US4).

## Constitution Check

*GATE: Must pass before Phase 0. Re-check after design.*

- Spec exists and is approved (pending owner approval of this plan); no implementation without spec. ✅
- Backend TDD: every backend task writes failing tests first (registry, CRUD, migrations, resolvers, executors). ✅
- Frontend user-visible behavior → Playwright (Skills list + Add-skill journey); frontend unit tests limited to non-visual logic (capability descriptor → form-field derivation, validation). ✅
- Stack unchanged: Node.js backend, React frontend. ✅
- PostgreSQL + `pgvector`. ✅
- LLM provider GPT-5.2 where AI is involved (no new prompts here except none — runtime copy stays LLM-generated; no hard-coded conversational strings for notify/decline). ✅
- Secrets via `.env`; no new secrets expected (capability uses existing connection credentials). `.env.example` updated only if a new var appears. ✅
- Customer data / auditability: skill CRUD audit + observability (FR-020); no credentials/message content in logs. ✅
- Module boundaries explicit: transport (CRUD route) / orchestration (dispatcher) / domain (capability registry + per-capability descriptors/executors) / persistence (spine repos). ✅
- Responsibility-limited files: the CRUD route and `SkillForm` MUST stay capability-neutral; `workspace-assistant-channels-tab.tsx` (already large) must SHRINK, not grow — bespoke cards are removed, not added to. ✅
- **Application composition**: the capability-type registry is app-wide replaceable infrastructure → default wiring lives in `backend/src/app/composition/` (registering each capability descriptor + its executor adapter, mirroring how `SkillExecutorRegistry` is composed today). Domain rules (per-capability schema/outcomes) live in `modules/`. ✅
- **HTTP contracts**: new `GET/POST/PATCH/DELETE /agents/{id}/skills` + `GET /agents/{id}/skill-capabilities` → register in `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml`/`.json` are regenerated, never hand-edited. ✅
- **Cross-service contracts**: SDK + MCP skill-related surfaces and any routine docs referencing skills update with the API change; message-queue review = the routine→skill dispatch path and any outbox actions (notify/webhook) — verify retry/idempotency semantics unchanged. ✅
- **Docs**: Skills authoring guide, settings docs, SDK/MCP references, routine docs referencing skills update in the same feature work (per slice). ✅

## Project Structure

### Documentation (this feature)

```text
specs/094-unified-skills/
├── plan.md            # this file
├── research.md        # design source of truth (current-state evidence + decisions)
├── data-model.md      # spine extension + capability registry + migrations
├── quickstart.md      # verification walkthrough
├── contracts/         # skills CRUD + skill-capabilities descriptor shapes
└── tasks.md           # phased TDD task list
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── composition/            # register capability registry + executor adapters (default wiring)
│   │   └── http/openapi/document.ts# register unified skills routes
│   ├── modules/
│   │   ├── skills/                 # capability-type registry + descriptor domain (the keystone seam)
│   │   │   ├── capabilityRegistry.ts
│   │   │   └── capabilities/       # per-capability descriptors (retrieve, mcpTool, email, slackPost, webhookCall, notify)
│   │   ├── agents/                 # agentSkills CRUD service + route + skill-capabilities projection
│   │   ├── externalSkills/ | webhookSkills/ | slackSkills/ | customerEmail/   # existing executors (reused)
│   │   ├── retrieval/              # retrieve capability descriptor + named-instance resolver/executor
│   │   └── routines/skillDispatcher.ts   # unchanged seam; gains retrieve named-instance resolver
│   ├── db/migrations/              # 1xx: invocation_mode + kind extension + retrieval/contact/webhook migrations
│   └── tests/                      # unit/integration/contract (TDD)
├── openapi.yaml / openapi.json     # regenerated
└── prompts/                        # no new runtime prompts expected

frontend/
├── components/dashboard/settings/
│   ├── skills/                     # NEW: SkillList + SkillForm (data-driven from descriptor)
│   └── workspace-assistant-channels-tab.tsx   # SHRINKS: bespoke cards removed
├── lib/api-skills.ts               # NEW unified adapter (replaces api-external-skills / api-customer-email / api-slack-skills)
└── e2e/                            # Playwright: add-skill journey

typescript-sdk/                     # regen from OpenAPI; skills surface
packages/radioso-mcp-server/        # if MCP exposes skills, keep in sync
docs/, docs-portal/                 # Skills authoring guide + settings docs + SDK/MCP refs
```

**Structure Decision**: Web (backend + frontend + packages). The **capability-type registry** in `backend/src/modules/skills/` owns "what a capability is" (domain); `backend/src/app/composition/` wires the default registry + executor adapters; the **agentSkills CRUD route** is transport-only and capability-neutral; the existing **`skillDispatcher` + `SkillExecutorRegistry`** remain the runtime seam. The frontend gets one `SkillForm`/`SkillList` driven by the descriptor; `workspace-assistant-channels-tab.tsx` loses its bespoke capability cards.

## Module Ownership & Seams

- **Transport Layer**: `agentSkills` CRUD route + `skill-capabilities` route (Express handlers; validate + delegate; no capability branching). Frontend `api-skills.ts` adapter.
- **Orchestration Layer**: existing `routines/skillDispatcher.ts` (resolve-by-name → executor) and the turn's default-answer path (selects the `default_answer` skill). Unchanged contracts; extended to resolve named `retrieve` instances and to honor `invocation_mode`.
- **Domain Layer**: **capability-type registry** + per-capability descriptors (`modules/skills/capabilities/*`) declaring target kind, input schema source, outcome vocabulary, supported invocation modes, executor adapter; per-capability config schemas (Zod). Retrieval scope/instruction semantics stay in `modules/retrieval`.
- **Persistence/Integration Layer**: `agent_skills` spine repositories (existing `externalSkillDefinitionRepository`, `emailSkillDefinitionRepository`, `webhookSkillDefinitionRepository`, slack repo) generalized behind a **uniform skill repository** read/write keyed by kind; connection/target lookups via existing connection repos. Retrieval default/named instances persisted on the spine.
- **Application Composition**: `backend/src/app/composition/` registers the capability registry entries and binds each to its executor adapter in `SkillExecutorRegistry` (mirrors today's executor composition). This is the app-wide replaceable infra per CLAUDE.md.
- **Files Kept Small**: `workspace-assistant-channels-tab.tsx` MUST shrink; the CRUD route MUST NOT accrete per-capability logic; `skillDispatcher.ts` stays a thin resolve→dispatch.
- **Planned Extractions**: `capabilityRegistry.ts` + `capabilities/*` descriptors; `SkillForm`/`SkillList`; unified `api-skills.ts`; a uniform spine skill repository (or a thin facade over the existing per-kind repos) so the CRUD service is capability-neutral.
- **Required Refactor Stories**: F0 introduces the registry + uniform repository facade before any UI cutover. Retrieval-onto-spine (US2) is a data-model refactor that must land behavior-preserving before named retrieve instances are exposed.

## Phasing

- **F0 (foundational, blocks all)**: capability-type registry + uniform spine skill repository facade + `invocation_mode` column + kind-check extension migration + unified CRUD/`skill-capabilities` API over the **existing four kinds** (no behavior change). Legacy per-kind routes become thin shims.
- **US1 (P1)**: frontend unified `SkillList` + data-driven `SkillForm` + `api-skills.ts` over F0; remove MCP/email/Slack bespoke cards; connection/skill separation.
- **US2 (P2)**: retrieval onto the spine as named instances; migrate the JSONB singleton to the `default_answer` instance (behavior-preserving); `retrieve` capability descriptor + named-instance resolver/executor; `@retrieve_events`.
- **US3 (P2)**: `invocation_mode` runtime semantics across selection (default-answer / routine-named / agent-selectable); enforce single default-answer.
- **US4 (P3)**: fold contact→`notify` and webhook-export→`webhook_call`; remove last bespoke cards; behavior-preserving migrations; suggested-questions becomes a retrieve-skill setting.

Each phase is an independently shippable PR. Behavior-preserving slices (F0, US2, US4 migrations) ship with regression proof before the additive ability is exposed.

## Complexity Tracking

No constitution violations to justify. The capability registry adds one indirection layer, justified by SC-005 (a new capability = one registry entry + one executor, zero route/form changes) and by removing six bespoke cards / three API adapters. The simpler "branch on kind in the route/form" alternative is rejected in research.md (god-route/god-form).
