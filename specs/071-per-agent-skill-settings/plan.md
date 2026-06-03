# Implementation Plan: Per-Agent Skill Settings (Retrieval First)

**Branch**: `071-per-agent-skill-settings` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/071-per-agent-skill-settings/spec.md`

## Summary

Make retrieval configuration a **per-agent skill setting** and retire the workspace retrieval layer.
Introduce one general seam — `agent.skillSettings` keyed by skill name, validated by each skill's own
`settingsSchema`, resolved `defaults ⊕ agent-override` inherit-by-default — with `retrieval.answer` as
its first consumer. Move retrieval defaults to the system/embedding-model layer (provider/model via the
central `resolveLlmConfig`), fold `sourceScope` + `metadataRules` into the per-agent retrieval settings,
then delete the workspace `retrieval_settings` retrieval/query-time config, its page, and the
`get/update_retrieval_settings` REST + MCP surfaces — preserving behavior via a one-time migration
snapshot. Knowledge base ends up owning ingestion only.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), TypeScript 5.7 / React 19 / Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, Pino, pgvector, OpenAI SDK + provider adapters; conversation-engine / skill-contract packages
**Storage**: PostgreSQL 16 (`agents.skill_settings` JSONB; removal of retrieval/query-time columns on `retrieval_settings`)
**Testing**: Vitest + Supertest (unit/integration/contract), Playwright (frontend journeys)
**Target Platform**: Self-hosted Docker stack (`docker-compose.yml`)
**Project Type**: Web (backend + frontend + packages + SDK + MCP)
**Performance Goals**: No added per-turn LLM round-trips; resolution is in-memory merge (negligible)
**Constraints**: Preserve grounded-answer parity; multilingual (no English keyword lists); public contract change
**Scale/Scope**: All agents/workspaces; SDK + MCP consumers; one data migration

## Constitution Check

*GATE: must pass before Phase 0 research (done) and re-check after design.*

- **Spec approved before implementation** — spec is Draft; implementation gated on approval. ✅ (pending approval)
- **TDD backend** — every slice starts with failing tests: domain normalization of `skillSettings`, resolver merge (inherit-by-default), migration parity, contract removal. ✅ planned
- **Frontend Playwright for visible behavior** — Skills-tab retrieval config (inherit display, advanced section, default-on) covered by Playwright; unit tests limited to the settings-form data transform/adapter. ✅ planned
- **Node backend / React frontend** — unchanged. ✅
- **PostgreSQL + pgvector** — unchanged; JSONB column add + column removals. ✅
- **LLM default centrally configured** — defaults consume `resolveLlmConfig` (`LLM_PROVIDER` + per-capability env); **no new hard-coded provider/model site** (FR-015). ✅
- **Secrets via `.env`; update `.env.example`** — no new secrets; if any default env surfaces, document it. ✅
- **Customer data / least privilege** — migration touches tenant retrieval config; run inside a transaction, auditable. ✅
- **Module boundaries explicit** — see Module Ownership. ✅
- **Responsibility-limited files identified** — `ChatService`/turn loop must NOT gain a retrieval branch; `agents/domain.ts` normalization stays mapping-only; settings module sheds retrieval/query-time ownership. ✅
- **App composition ownership** — the new `SkillSettingsResolver` and system-default provider are replaceable runtime wiring ⇒ assembled in `backend/src/app/composition/`; domain rules stay in modules. ✅ (matches CLAUDE.md composition rule)
- **OpenAPI is generated** — agent schema gains `skillSettings`; retrieval-settings paths removed via the code-first registry (`backend/src/app/http/openapi/document.ts`); `backend/openapi.{yaml,json}` regenerated, never hand-edited. ✅
- **Cross-service contract → message-queue impact review** — REQUIRED: removing `get/update_retrieval_settings` and reshaping agent config affects the **SDK**, **MCP server**, and possibly worker payloads. Review document-worker dispatch, AMQP payloads, retry semantics, queue tests/docs. ⚠️ tracked as a plan task (see Contract Impact).
- **Docs updated in same change** — `readme.md` (retrieval settings operators tune), `docs/` retrieval + MCP + SDK pages, settings docs, and any local README briefs. Follow `docs/document-writer-prompt.md`. ✅ planned

No constitution violations requiring Complexity Tracking.

## Project Structure

```text
specs/071-per-agent-skill-settings/
├── spec.md
├── plan.md          # this file
├── research.md      # decisions + governance audit query
├── data-model.md    # entities, resolution, migration mapping
└── contracts/       # (to add) agent schema delta + removed retrieval-settings paths
```

```text
backend/
├── src/
│   ├── modules/
│   │   ├── agents/                 # domain.ts: add opaque skillSettings (normalize like surfaceSettings.extensions)
│   │   ├── skills/                 # settingsSchema is the validator/source-of-truth (no change to contract mechanism)
│   │   └── settings/               # retrieval module: override shape (+sourceScope), system defaults, resolver inputs; SHED workspace retrieval record
│   ├── app/
│   │   ├── composition/            # wire SkillSettingsResolver + system-default provider
│   │   └── http/
│   │       ├── routes/             # agent PATCH carries skillSettings; REMOVE retrieval-settings routes
│   │       └── openapi/            # registry: add agent.skillSettings, remove retrieval-settings paths → regen openapi.{yaml,json}
│   ├── db/
│   │   ├── migrations/             # add agents.skill_settings; data migration; drop retrieval/query-time cols
│   │   └── repositories/           # agentRepository (map skill_settings); retrievalSettingsRepository (remove retrieval reads/writes)
│   └── modules/chat/services/      # caller reads agent.skillSettings["retrieval.answer"]; NO new branch
typescript-sdk/                     # regen client; drop retrieval-settings methods
packages/radioso-mcp-server/        # remove get/update_retrieval_settings tools + policy entries
frontend/
└── src/ (agent Skills tab)         # render retrieval config from settingsSchema; REMOVE workspace retrieval page
```

**Structure Decision**: Web (Option 2). Orchestration lives in `chat`/composition, domain rules in
`agents` + `settings(retrieval)` + `skills`, persistence in `db/repositories`, UI in the agent Skills tab.

## Module Ownership & Seams

- **Transport Layer**: agent PATCH route (carries `skillSettings`); removed retrieval-settings routes; MCP tool registry (tools removed).
- **Orchestration Layer**: `chat` turn services + `app/composition` (assemble resolver, hand effective settings to the skill dispatcher). No retrieval-specific branch.
- **Domain Layer**: `agents/domain.ts` (opaque `skillSettings` normalization); `settings` retrieval module (override shape incl. `sourceScope`, system defaults, merge rule); `skills` (`settingsSchema` validation).
- **Persistence/Integration Layer**: `agentRepository` (`skill_settings` JSONB); `retrievalSettingsRepository` (retrieval reads/writes removed; ingestion fields like `chunking_strategy` may remain).
- **Application Composition**: REQUIRED — `SkillSettingsResolver` port and the system/model retrieval-default provider are app-wide replaceable wiring ⇒ assembled in `backend/src/app/composition/`; domain rules stay in modules.
- **Files Kept Small**: `ChatService`/turn loop (no retrieval branch); `agents/domain.ts` (mapping-only, no retrieval shape knowledge — store opaque).
- **Planned Extractions**: (1) `SkillSettingsResolver` `(skill, defaults, agentOverride) → effectiveSettings`; (2) system/model `RetrievalDefaultsProvider` (reads `resolveLlmConfig`); (3) migration module for the one-time snapshot.
- **Required Refactor Stories**: none blocking — the seam reuses the `surfaceSettings.extensions` pattern; no oversized target file must be split first.

## Phasing (maps to spec user stories)

1. **US1 + US2 (P1, MVP)** — add `agents.skill_settings`; opaque normalization; `SkillSettingsResolver` in composition; assistant caller reads `skillSettings["retrieval.answer"]`; defaults still sourced from the existing workspace record *as the default layer* (no deletion yet). Retrieval default-on + inherit. Skills-tab form (behavioral + advanced + inherited display). Ships value with zero deletion risk.
2. **US3 (P2)** — extend `RetrievalSettingsOverride` with `sourceScope`; move `metadataRules` per-agent; consolidate "which docs."
3. **US4 (P2)** — introduce the system/model `RetrievalDefaultsProvider` (replaces workspace defaults); run the migration snapshot; delete the workspace retrieval/query-time columns + `attribute_controls`, the page, REST endpoints, and MCP tools. Regenerate OpenAPI/SDK/MCP. **Gated on G1 audit + parity tests.**
4. ~~**US5 (P3, conditional)**~~ — **dropped** per G1 audit (0 governance-shaped filters in 419 workspaces). Not built; re-confirm against production before the destructive migration.

## Contract Impact (message-queue + public contracts)

- **REST**: remove `GET/PUT .../retrieval-settings`; add `skillSettings` to the agent schema. Regenerate `backend/openapi.{yaml,json}` from the registry.
- **MCP**: remove `get_retrieval_settings` / `update_retrieval_settings` tools and their `capabilityPolicy` / `TOOL_CATALOG` entries; update `describe_capabilities` output and smoke tests.
- **SDK**: regenerate; drop retrieval-settings methods; changelog + migration note for consumers.
- **Worker/AMQP**: review whether any document-worker dispatch or queue payload reads workspace retrieval settings (rewrite/rerank/embedding config is resolved separately via `resolveLlmConfig`); confirm no payload carries the removed fields. Update queue tests/docs if touched.
- **Deprecation**: removed MCP tools/endpoints return a clear, documented removal error for old clients.

## Docs to update (same change)

`readme.md` (retrieval settings operators tune), `docs/` retrieval + settings + MCP + SDK pages, the agent
settings docs used by the product UI, and any local README briefs whose ownership moves. Read
`docs/document-writer-prompt.md` first.

## Open Gates (carried from spec)

- **G1** governance audit — **RESOLVED** (0 governance filters in 419 workspaces ⇒ clean delete, US5 dropped). Residual: re-run research.md query against production immediately before the destructive migration.
- **G2** default-drift semantics — **RESOLVED** (explicit overrides don't drift; only unset fields follow new defaults).
