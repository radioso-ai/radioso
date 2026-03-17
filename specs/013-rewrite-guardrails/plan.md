# Implementation Plan: Assistive Rewrite Guardrails

**Branch**: `013-rewrite-guardrails` | **Date**: 2026-03-17 | **Spec**: [/Users/dm/code/hivec-rewrite-guardrails/specs/013-rewrite-guardrails/spec.md](/Users/dm/code/hivec-rewrite-guardrails/specs/013-rewrite-guardrails/spec.md)
**Input**: Feature specification from `/specs/013-rewrite-guardrails/spec.md`

## Summary

Harden Hivec's retrieval rewrite path so the LLM can propose a standalone
retrieval interpretation without becoming the authority for subject continuity.
The plan adds structured rewrite output, an explicit rewrite-eligibility gate,
evidence-based validation between raw and rewritten retrieval, hallucination and
ambiguity guards, and focused continuity-policy seams. The design keeps
transport thin, keeps `RetrievalPipelineService` orchestration-only, and avoids
letting `QueryRewriteService` own state-trust decisions.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertest, existing retrieval pipeline services, existing chat streaming route  
**Storage**: PostgreSQL unchanged; no new storage system, with additive diagnostics or continuity support only if required  
**Testing**: Vitest + Supertest with backend TDD first; unit coverage for rewrite and continuity policy plus targeted integration and contract verification  
**Target Platform**: Web application with browser chat UI and Node.js API  
**Project Type**: web application  
**Performance Goals**: Preserve current chat latency envelope, run at most one extra rewritten retrieval only for eligible turns, and keep validation logic linear in the number of bounded candidate sets already produced by the pipeline  
**Constraints**: Rewrite stays assistive not authoritative, ambiguity must be preserved, heuristic subject extraction from prior raw user text must not author continuity state, explicit current-turn subject beats related entities, and malformed or hallucinated rewrite proposals must degrade safely to raw-query behavior  
**Scale/Scope**: One retrieval pipeline, one rewrite gateway contract, one continuity decision path, one diagnostics shape, and regression coverage for referential, relational, comparative, ambiguous, multilingual, and hallucination-prone follow-up turns

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; the first implementation slice must add failing unit and integration coverage before any retrieval behavior changes.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; no storage-system changes are planned.
- LLM provider is GPT-5.2 for AI integrations. Pass; the feature tightens rewrite contracts without changing providers.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets are expected.
- Customer data handling and auditability are addressed where applicable. Pass; all continuity decisions remain account-scoped and additive diagnostics stay within existing chat telemetry surfaces.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; continuity policy and rewrite validation are extracted into focused retrieval-domain seams.
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
New decision logic for rewrite eligibility, hallucination guarding, evidence
comparison, and trusted-subject continuity must live in focused modules under
`backend/src/modules/retrieval/domain/` or `backend/src/modules/retrieval/services/`
without pushing policy into routes or broadening existing orchestration files.

## Module Ownership & Seams

- **Transport Layer**: existing chat HTTP routes and app dependency wiring under `backend/src/app/`
- **Orchestration Layer**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, which coordinates context selection, rewrite proposal, retrieval, candidate preparation, reranking, and telemetry without owning continuity policy rules
- **Domain Layer**: new focused seams for structured rewrite results, rewrite eligibility, hallucination guarding, evidence comparison, material-disagreement detection, and trusted-subject continuity decisions
- **Persistence/Integration Layer**: existing repositories, vector search, lexical search, and the OpenAI rewrite gateway; additive diagnostics only if needed
- **Files Kept Small**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/retrieval/services/queryRewriteService.ts`, `backend/src/app/server/dependencies.ts`
- **Planned Extractions**: `StructuredRewriteResult` model, `RewriteEligibilityService`, `RewriteHallucinationGuard`, `RetrievalEvidenceComparisonService`, `SubjectContinuityService`, and focused telemetry/result-shaping helpers for continuity diagnostics
- **Required Refactor Stories**: extract continuity and validation decisions before layering new rules into the current rewrite and pipeline services; keep dependency wiring additive and explicit rather than embedding policy in constructor setup

## Phase 0: Research Decisions

- Use structured rewrite output instead of plain text so the pipeline can reason
  about turn kind, proposed subject, related entities, unresolved status, and
  confidence without inferring state from paraphrased text.
- Define rewritten-retrieval eligibility from the structured rewrite itself:
  only materially different, grounded, non-unresolved proposals trigger the
  extra retrieval path.
- Define material disagreement as a domain decision based on subject-cluster
  mismatch, ungrounded new subjects, relation-to-subject collapse, or false
  certainty introduced into ambiguous turns.
- Preserve ambiguity by retaining the prior trusted subject or leaving the turn
  unresolved when evidence does not converge.
- Remove heuristic subject carry-forward from prior raw user text as an
  authority and replace it with explicit evidence-based continuity policy.

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
   eligibility, hallucination rejection, explicit-subject precedence, ambiguity
   preservation, and material-disagreement decisions.
2. Add failing retrieval-pipeline integration tests that cover raw-only turns,
   eligible rewritten turns, disagreement handling, unresolved turns, and safe
   fallback when rewrite output is malformed or ungrounded.
3. Refactor `QueryRewriteService` so it returns a structured proposal instead of
   a plain-text rewrite result while keeping gateway concerns limited to model
   invocation and output normalization.
4. Introduce focused retrieval-domain services that decide rewrite eligibility,
   compare raw and rewritten evidence, and determine whether the trusted subject
   is retained, updated, or left unresolved.
5. Update `RetrievalPipelineService` to orchestrate both raw and conditional
   rewritten retrieval paths using the new services without absorbing policy
   logic.
6. Extend diagnostics so each rewritten turn records the proposal, whether the
   rewritten path ran, whether evidence converged, and the resulting continuity
   decision.
7. Re-run regression coverage for existing standalone subject queries to confirm
   the new policy does not perturb unaffected turns.

## Testing Strategy

- Backend unit tests for structured rewrite parsing and normalization
- Backend unit tests for rewrite eligibility and the definition of materially
  different standalone queries
- Backend unit tests for hallucination rejection and ambiguity preservation
- Backend unit tests for explicit subject precedence versus related-entity
  mentions in relation and comparative turns
- Backend unit tests for continuity decisions under agreement, disagreement, and
  unresolved evidence
- Backend integration tests for retrieval pipeline behavior when rewrite is
  skipped, applied, rejected, or downgraded to raw-query behavior
- Backend contract or payload tests for additive diagnostics if continuity
  fields become externally visible

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
