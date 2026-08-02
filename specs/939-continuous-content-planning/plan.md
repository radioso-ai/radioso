# Implementation Plan: Continuous Content Planning

**Branch**: `find-next-good-issue` (Conductor workspace; feature artifacts use `939-continuous-content-planning`) | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `/specs/939-continuous-content-planning/spec.md`

## Summary

Add a continuously maintained Content plan for one workspace operator. Every
successfully committed visitor turn carries a structured, capability-neutral
interaction role and the semantic intents retrieval actually used. Compatible query
vectors are registered idempotently in the assistant-turn transaction; a bounded
worker embeds only missing vectors, assigns observations incrementally to stable
topics, refreshes material enrichments, and keeps a coherent 30-day/current versus
previous-30-day read model. A standalone Content Planning module owns projection,
ranking, recommendation, and three read-only APIs. The dashboard adds a decision-first
Content plan destination under Activity with a singular recommendation, ranked topic
list, responsive evidence detail, and handoffs into existing Quality and Knowledge
flows.

## Technical Context

**Language/Version**: TypeScript 5.7/5.9 on Node.js 24; React 19 / Next.js 16
**Primary Dependencies**: Express, Zod, Kysely, PostgreSQL `pgvector`, OpenAI/provider adapters, Radix UI, Lucide
**Storage**: PostgreSQL 16; concurrent prerequisite indexes in migrations 134–135 and `136_content_planning.sql` with source observations, per-space vectors, projection generations, frozen replay populations, topics, memberships, enrichments, topic-document evidence, and bounded corpus/enrichment repair cursors
**Testing**: Vitest, Supertest, real-Postgres integration tests, deterministic multilingual clustering fixture, Playwright
**Target Platform**: Self-hosted Linux API/document worker and modern desktop/mobile browsers
**Project Type**: pnpm web monorepo with backend, dashboard, reusable conversation packages, SDK, MCP generated types, and docs portal
**Performance Goals**: 95% of normal observations coherent within two minutes; intake adds no provider call and no more than 25 ms p95; first Content plan page under two seconds at 20,000 retained observations
**Constraints**: fixed rolling 30-day/current plus equal comparison window; no scheduled report; no extra rewrite for retrieval turns; no incompatible vector comparison; no customer text/vectors/generated prose in telemetry; deterministic ranking/action policy; raw source text remains message-owned
**Scale/Scope**: six approved stories, 60-day active observation horizon, up to ten generated opportunity briefs per workspace projection, one operator-oriented dashboard surface

## Constitution Check

*GATE: passed before research and re-checked after design.*

- **PASS — approval**: `spec.md` is explicitly approved and its checklist records approval on 2026-08-02.
- **PASS — backend TDD**: every backend behavior slice has an explicit failing unit,
  contract, fixture, or integration-test task before production code.
- **PASS — frontend coverage**: Playwright owns visible navigation, responsive detail,
  states, accessibility, and remediation journeys. Unit tests are limited to API,
  route, stale-request, formatting, and outline transforms.
- **PASS — stack**: the feature remains Node.js/React/PostgreSQL/pgvector and adds no storage service or frontend state library.
- **PASS — LLM boundary**: existing workspace model resolution is used. New structured
  prompt assets live under `backend/prompts/content-planning/`; the two turn-understanding
  prompts under `backend/prompts/chat/` are extended in place.
- **PASS — secrets**: no new secret is introduced. Versioned thresholds and bounded
  bootstrap/enrichment budgets are server-owned behavior constants, not credentials.
- **PASS — customer data**: observations store source IDs, a non-reversible semantic
  hash, vectors, grounding scalars, and membership. Question/semantic text is fetched
  from authorized message-owned data only while needed. Logs, metrics, traces, and
  analytics exclude questions, vectors, labels, briefs, document text, prompts, and completions.
- **PASS — modularity**: Content Planning owns its domain and persistence ports; Chat
  emits neutral turn understanding; Retrieval exposes neutral vector envelopes;
  Quality owns the shared population/remediation evidence policy; HTTP only validates
  and presents; composition assembles the cross-module adapters.
- **PASS — responsibility limits**: focused modules keep `chatTurnLifecycle.ts`,
  retrieval stages, `quality/service.ts`, `quality-view.tsx`, HTTP registries, and
  dashboard shell/navigation files as wiring or presentation surfaces.
- **PASS — composition**: `backend/src/app/composition/` wires the transactional
  observation writer, Quality evidence adapter, clustering/corpus/enrichment adapters,
  route module, and worker lifecycle. Product rules stay under modules.
- **PASS — code-first HTTP**: Zod-backed schemas and paths are authored first;
  `backend/openapi.yaml` and `.json` plus SDK/MCP types are generated outputs.
- **PASS — queue review**: no AMQP or document-processing job payload changes. The
  Content Planning processor claims PostgreSQL rows from the existing long-lived
  backend worker runtime; document and crawler worker contracts/retries remain unchanged.
- **PASS — docs**: API/operator docs, Quality/Chat/Retrieval/Content Planning briefs,
  frontend brief, architecture code map, and generated public contracts change together.
- **PASS — observability**: safe structured logs, bounded-label metrics, and trace spans
  cover intake, claim, embedding, assignment, reconciliation, enrichment,
  bootstrap/reprojection, degradation, and retry; ordinary reads add no audit event.

Post-design re-check: all gates remain satisfied. The design deliberately accepts the
necessary normalized membership rows and dual-space vector rows; these are the minimum
state required for idempotent counting and coherent embedding-space handoff.

## Project Structure

### Documentation (this feature)

```text
specs/939-continuous-content-planning/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http-api.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code

```text
packages/conversation-contract/
└── index.d.ts                              # neutral interaction-role contract

packages/conversation-engine/
└── src/                                    # opaque interaction metadata propagation/redacted trace

backend/
├── prompts/
│   ├── chat/{turn-planning,turn-interpretation}.md
│   └── content-planning/{topic-label,content-brief}.md
├── src/
│   ├── modules/contentPlanning/
│   │   ├── contracts/
│   │   ├── domain/
│   │   ├── services/
│   │   ├── routes.ts
│   │   ├── worker.ts
│   │   ├── composition.ts
│   │   └── README.md
│   ├── modules/chat/                       # neutral role + committed-turn envelope
│   ├── modules/retrieval/                  # consumer-neutral semantic vector envelopes
│   ├── modules/quality/contentPlanningEvidence.ts
│   ├── db/migrations/134_content_planning_conversation_index.sql
│   ├── db/migrations/135_content_planning_document_index.sql
│   ├── db/migrations/136_content_planning.sql
│   ├── db/repositories/contentPlanning*.ts
│   ├── app/composition/builtIn/contentPlanningModule.ts
│   ├── app/http/openapi/{schemas,paths}/contentPlanning*.ts
│   ├── app/server/{dependencies,dependencyBuilders,types}.ts
│   └── runtime/startWorkerRuntime.ts
├── tests/{unit,integration,contract,fixtures}/
└── openapi.{yaml,json}                     # generated

frontend/
├── components/dashboard/
│   ├── content-plan-view.tsx
│   └── content-plan/
├── lib/{api-content-plan,content-plan,dashboard-routes}.ts
└── tests/{unit,e2e}/

typescript-sdk/{openapi,src/generated}/     # generated contract alignment
packages/radioso-mcp-server/src/generated/  # generated types; no MCP tool
docs/
docs-portal/content/
```

**Structure Decision**: extend the existing monorepo with one standalone backend
domain module and focused adapters. The transactional intake adapter is injected into
Chat without a Chat-to-Content-Planning import. The processor starts only in the
long-lived backend worker runtime. The frontend is implemented by Claude after Codex
locks the HTTP contract; Claude owns `frontend/**`, while Codex owns backend, shared
contracts/packages, feature artifacts, generated API outputs, and integration.

## Module Ownership & Seams

- **Transport Layer**: `contentPlanning/routes.ts` validates list/detail/member-turn
  requests, requires `workspace.quality.read`, maps typed not-found/redirect behavior,
  and calls a read service. Code-first Zod/OpenAPI files mirror the runtime contract.
- **Orchestration Layer**: intake registration, observation processing, projection
  bootstrap/reprojection, enrichment scheduling, and read assembly are separate
  services. The worker claims one bounded work item/batch and delegates all decisions.
- **Domain Layer**: pure modules own interaction eligibility after lifecycle override,
  assignment/cohesion, maturity/merge/retirement, rolling windows, trend,
  evidence-strength, opportunity eligibility, ranking, action selection, and dirty
  enrichment rules. Ranking version 1 is a stable lexicographic tuple, not a floating
  client score.
- **Persistence/Integration Layer**: Kysely repositories own observations, per-space
  vectors, projection state, topics/memberships, revision-fenced enrichments, and
  topic-document links. pgvector/claim SQL lives in typed Kysely helpers. Provider
  adapters expose clustering embeddings and validated structured generation. Frozen
  generation-owned population rows make bootstrap/reprojection coherent while source
  deletion still cascades immediately. Workspace corpus markers and generation repair
  cursors turn fan-out/repair into resumable bounded work. Source message text is loaded
  only through authorized/bounded source reads.
- **Quality Port**: Quality exposes a read-only content-planning evidence source using
  its canonical population, effective triage, grounding mapper, and Eval verification.
  The canonical population query is shared through Quality's narrow public seam;
  Content Planning neither duplicates its rules nor reads Quality internals. Existing
  list/stats/triage services do not become projection writers.
- **Chat Port**: Chat defines a neutral transactional committed-turn observation
  writer. `PostgresAssistantTurnPersistence` invokes it idempotently within the
  existing assistant message/audit transaction. It writes only intake/vector state;
  no clustering or provider call occurs there.
- **Retrieval Port**: deterministic and agentic retrieval results expose bounded
  semantic vector envelopes `{intentId, semanticTextHash, vector, space}` for the
  queries actually embedded/searched. No report types or calls enter Retrieval.
- **Application Composition**: constructs the Content Planning repositories/services,
  adapts Quality and embedding/LLM/document capabilities, injects the transactional
  writer, registers the route mount, and exposes the worker in `AppDependencies`.
  `startWorkerRuntime.ts` starts/stops the poller; general module initialization does not.
- **Frontend Presentation**: `api-content-plan.ts` mirrors contracts. Backend ordering,
  bands, rates, actions, and labels are rendered rather than recomputed. The view owns
  abort/stale-request protection, route state, focus restoration, and responsive layout.
- **Files Kept Small**: `chatTurnLifecycle.ts`, `chatTurnAssembly.ts`,
  `candidateRetrievalStage.ts`, `quality/service.ts`, `quality-view.tsx`,
  `documents-view.tsx`, `dashboard-shell.tsx`, OpenAPI registries, dependency builders,
  and worker runtime receive narrow fields/wiring only.
- **Planned Extractions**: interaction-role parser/resolver; semantic-vector envelope;
  transactional intake port/adapter; Quality evidence source; projection repositories;
  pure topic/ranking/action policies; worker processors; enrichment gateway/prompt
  validators; read presenter; Content plan UI summary/list/detail/composition components.
- **Required Refactor Stories**: the neutral interaction metadata and vector-envelope
  extractions land before Content Planning consumes them. No unrelated broad refactor is required.

## Delivery Boundaries

1. Shared neutral contracts and failing tests land first.
2. Codex locks the backend DTO/OpenAPI design contract before Claude begins frontend
   adapters and UI.
3. Codex implements schema, transactional intake, projection domain/worker, Quality
   evidence, APIs, generation, observability, generated contracts, and docs using TDD.
4. Claude implements only `frontend/**` against the locked contract, including
   Playwright coverage and Quality/Knowledge handoffs.
5. Codex integrates, runs broad validation, performs senior-engineer review loops and
   one engineering-manager review, then prepares the PR.

## Complexity Tracking

| Necessary complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Per-observation/per-projection membership rows | Exact idempotent demand, evidence drill-down, deletion reconciliation, and dual-space handoff require source membership | Cached counters cannot reconcile triage/Eval/deletion changes or list member turns |
| Separate observation vectors from observations | Old coherent and new target embedding spaces must coexist without comparison | One vector column would overwrite the readable projection during reprojection |
| Revision-fenced enrichment state | Provider calls are async and may finish after a newer topic revision | In-place unversioned prose can publish stale or deleted evidence |
| Normalized topic-document evidence | Document deletion/change must invalidate recommendations and preserve deterministic action evidence | JSON-only links can dangle and make invalidation/scoping error-prone |
