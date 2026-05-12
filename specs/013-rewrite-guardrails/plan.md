# Implementation Plan: Assistive Rewrite Guardrails

**Branch**: `013-rewrite-guardrails` | **Date**: 2026-03-17 | **Spec**: [/Users/dm/code/radioso-rewrite-guardrails/specs/013-rewrite-guardrails/spec.md](/Users/dm/code/radioso-rewrite-guardrails/specs/013-rewrite-guardrails/spec.md)
**Input**: Feature specification from `/specs/013-rewrite-guardrails/spec.md`

## Summary

Harden Hivec's retrieval rewrite path so the LLM can propose a standalone
retrieval interpretation without becoming the authority for conversation state,
while keeping the online path fast enough for production use. The implemented
design uses structured rewrite output, one active semantic retrieval query
(`rewrittenQuery || rawQuery`), bounded carry-forward hints from the immediately
previous assistant answer, anti-noise rewrite rules, and additive diagnostics.
The design keeps transport thin, keeps `RetrievalPipelineService`
orchestration-only, and avoids letting `QueryRewriteService` own persisted
state.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertest, existing retrieval pipeline services, existing chat streaming route  
**Storage**: PostgreSQL unchanged; no new storage system, with additive diagnostics or continuity support only if required  
**Testing**: Vitest + Supertest with backend TDD first; unit coverage for rewrite and continuity policy plus targeted integration and contract verification  
**Target Platform**: Web application with browser chat UI and Node.js API  
**Project Type**: web application  
**Performance Goals**: Preserve current chat latency envelope by avoiding dual semantic retrieval when rewrite is available, use a dedicated fast rerank model, and keep rewrite safety checks bounded to prompt/usability guards  
**Constraints**: Rewrite stays assistive not authoritative, ambiguity must be preserved, explicit current-turn subject beats related entities, noisy meta-rewrites must degrade safely to raw-query behavior, and carry-forward context must remain bounded  
**Scale/Scope**: One retrieval pipeline, one structured rewrite gateway contract, one active semantic search path, one rerank model override, one diagnostics shape, and regression coverage for referential, relational, comparative, ambiguous, multilingual, and noise-prone follow-up turns

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; the first implementation slice must add failing unit and integration coverage before any retrieval behavior changes.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; no storage-system changes are planned.
- LLM provider is GPT-5.2 for AI integrations. Pass; the feature tightens rewrite contracts without changing providers.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets are expected.
- Customer data handling and auditability are addressed where applicable. Pass; all continuity decisions remain account-scoped and additive diagnostics stay within existing chat telemetry surfaces.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; rewrite prompt policy, carry-forward selection, and diagnostics remain in focused seams.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; `retrievalPipelineService.ts` and `queryRewriteService.ts` already carry substantial logic and must stay narrow through extractions.

## Project Structure

### Documentation (this feature)

```text
specs/013-rewrite-guardrails/
├── plan.md
├── checklists/
│   └── requirements.md
├── research.md          # Optional next-phase output if planning continues
├── data-model.md        # Optional next-phase output if planning continues
├── quickstart.md        # Optional next-phase output if planning continues
├── contracts/           # Optional next-phase output if planning continues
└── tasks.md             # Not created in this stop-at-plan pass
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   └── server/
│   ├── db/
│   │   └── repositories/
│   └── modules/
│       ├── chat/
│       ├── retrieval/
│       │   ├── domain/
│       │   ├── infra/
│       │   └── services/
│       └── settings/
└── tests/
    ├── contract/
    ├── integration/
    ├── support/
    └── unit/

frontend/
├── app/
├── components/
└── lib/
```

**Structure Decision**: This feature is primarily backend retrieval-domain work.
Transport ownership remains in existing app wiring and chat routes. Retrieval
orchestration remains in `backend/src/modules/retrieval/services/retrievalPipelineService.ts`.
Rewrite proposal generation remains in
`backend/src/modules/retrieval/services/queryRewriteService.ts` and its gateway.
Carry-forward selection stays in `ConversationContextService`, and rewrite noise
handling stays in the rewrite service rather than routes or prompt builders.

## Module Ownership & Seams

- **Transport Layer**: existing chat HTTP routes and app dependency wiring under `backend/src/app/`
- **Orchestration Layer**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, which coordinates context selection, rewrite proposal, one active semantic retrieval path, lexical retrieval, reranking, and telemetry without owning prompt policy rules
- **Domain Layer**: focused seams for structured rewrite results, rewrite eligibility, carry-forward selection, rewrite noise detection, and continuity annotations
- **Persistence/Integration Layer**: existing repositories, vector search, lexical search, and the OpenAI rewrite gateway; additive diagnostics only if needed
- **Files Kept Small**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/retrieval/services/queryRewriteService.ts`, `backend/src/app/server/dependencies.ts`
- **Planned Extractions**: `StructuredRewriteResult` model, `RewriteEligibilityService`, bounded carry-forward helpers, and focused telemetry/result-shaping helpers for rewrite diagnostics
- **Required Refactor Stories**: keep carry-forward and rewrite prompt policy narrow, and keep dependency wiring additive and explicit rather than embedding policy in constructor setup

## Phase 0: Research Decisions

- Use structured rewrite output instead of plain text so the pipeline can reason
  about turn kind, proposed subject, related entities, unresolved status, and
  confidence without inferring state from paraphrased text.
- Use one active semantic retrieval query on the hot path rather than dual raw
  and rewritten semantic searches.
- Preserve ambiguity as a diagnostic annotation instead of a retrieval-time
  branch comparison.
- Use a bounded carry-forward hint from the immediately previous assistant
  answer so short follow-ups can stay concrete.
- Reject abstract meta-language and checklist-style rewrite expansions before
  retrieval uses them.
- Use a dedicated fast rerank model with small output budgets.

## Phase 1: Design Outputs

- `research.md` should capture the structured rewrite contract, disagreement
  rules, hallucination guard, and ambiguity-preservation decisions if planning
  continues beyond this stop point.
- `data-model.md` should define structured rewrite result fields, continuity
  decision outputs, and diagnostics payload shape if planning continues.
- `contracts/` should document any additive internal or API-visible diagnostics
  contract only if later phases confirm those fields need to cross boundaries.
- `quickstart.md` should document the TDD-first verification flow for rewrite,
  continuity, and regression scenarios if later phases proceed.

## Implementation Strategy

1. Add failing unit tests for structured rewrite normalization, rewrite
   eligibility, ambiguity preservation, meta-language rejection, and checklist
   expansion rejection.
2. Add failing retrieval-pipeline integration tests that cover raw-only turns,
   eligible rewritten turns, unresolved turns, and safe fallback when rewrite
   output is malformed or unusable.
3. Refactor `QueryRewriteService` so it returns a structured proposal, accepts a
   bounded carry-forward hint, and rejects noisy rewrites before retrieval.
4. Update `ConversationContextService` to derive a bounded carry-forward snippet
   from the immediately previous assistant answer.
5. Update `RetrievalPipelineService` to use one active semantic retrieval path
   using `rewrittenQuery || rawQuery` without dual semantic comparison.
6. Extend diagnostics so each rewritten turn records the proposal, whether the
   rewritten path ran, and the continuity annotation kept for that turn.
7. Introduce a dedicated fast rerank model and low-token rerank request shape.

## Testing Strategy

- Backend unit tests for structured rewrite parsing and normalization
- Backend unit tests for rewrite eligibility and the definition of materially
  different standalone queries
- Backend unit tests for ambiguity preservation, carry-forward selection, and
  rewrite noise rejection
- Backend unit tests for explicit subject precedence versus related-entity
  mentions in relation and comparative turns
- Backend integration tests for retrieval pipeline behavior when rewrite is
  skipped, applied, rejected as unusable, or downgraded to raw-query behavior
- Backend contract or payload tests for additive diagnostics if rewrite fields
  remain externally visible

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD is explicit and front-loaded. Pass.
- Stack discipline remains unchanged. Pass.
- No new secrets, storage systems, or provider changes are introduced. Pass.
- Transport, orchestration, domain, and persistence ownership remain explicit.
  Pass.
- The plan requires extraction of new domain seams before policy logic expands
  existing orchestration files. Pass.
- No constitution exceptions require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
