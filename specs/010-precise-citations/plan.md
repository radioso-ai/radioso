# Implementation Plan: Precise Citation Placement

**Branch**: `010-precise-citations` | **Date**: 2026-03-16 | **Spec**: [/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/spec.md](/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/spec.md)
**Input**: Feature specification from `/specs/010-precise-citations/spec.md`

## Summary

Replace Hivec's heuristic post-processing citation placement with explicit backend-generated citation anchors and deterministic parsing. The retrieval prompt will assign stable result numbers, the model will cite only through a parseable anchor format, and a focused chat-domain parser will convert the raw answer into exact `answerSegments` and visible citations for both JSON and SSE completion paths. The design keeps `ChatService` orchestration-only, keeps transport layers thin, and preserves existing frontend interactions by continuing to emit normalized `citations` plus exact placement metadata.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, OpenAI SDK, pg, Zod, Pino, Vitest, Supertest, Next.js App Router, existing chat streaming route  
**Storage**: PostgreSQL unchanged; no new persisted data for this feature  
**Testing**: Vitest + Supertest with backend TDD first; targeted frontend build verification  
**Target Platform**: Web application with browser chat UI and Node.js API  
**Project Type**: web application  
**Performance Goals**: Preserve current chat latency envelope, keep citation parsing linear in answer length, and avoid extra retrieval round-trips  
**Constraints**: No heuristic token-overlap placement, no frontend parsing of raw model anchors, streaming must remain readable during generation, completed SSE and JSON paths must converge to the same citation layout  
**Scale/Scope**: One grounded chat answer flow, one streaming completion flow, one citation presentation contract, and regression coverage for malformed anchors and multi-source claims

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; the task order starts with failing unit/integration/contract coverage for exact placement and malformed anchors.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; no storage changes are introduced.
- LLM provider is GPT-5.2 for AI integrations. Pass; only prompt instructions and parsing behavior change.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass; no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass; citation output remains account-scoped and built from existing retrieved contexts only.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; parsing is extracted into focused chat-domain seams instead of expanding `ChatService` or UI components.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; deterministic citation parsing is extracted before replacing the old heuristic logic.

## Project Structure

### Documentation (this feature)

```text
specs/010-precise-citations/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-citation-placement.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/
│   │   │   ├── presenters/
│   │   │   └── routes/
│   │   └── server/
│   ├── modules/
│   │   ├── chat/services/
│   │   └── retrieval/services/
│   └── db/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── app/
│   └── api/chat/stream/
├── components/
│   └── dashboard/
└── lib/
```

**Structure Decision**: Transport ownership remains in `backend/src/app/http/presenters/chatPresenter.ts` and the frontend streaming adapter. Orchestration remains in `backend/src/modules/chat/services/chatService.ts`. Prompt construction stays in `backend/src/modules/retrieval/services/promptBuilder.ts`. Exact citation-anchor parsing and normalized answer-segment construction will live in focused chat-domain modules under `backend/src/modules/chat/services/`. Frontend ownership remains in `frontend/lib/api.ts`, `frontend/lib/chat-context.tsx`, and `frontend/components/dashboard/chat-citations.tsx`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/presenters/chatPresenter.ts`, `frontend/app/api/chat/stream/route.ts`
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`
- **Domain Layer**: `backend/src/modules/chat/services/answerPresentationService.ts` plus a new focused citation-anchor parser/normalizer service; `backend/src/modules/retrieval/services/promptBuilder.ts` for result numbering and prompt instructions
- **Persistence/Integration Layer**: existing retrieval pipeline, repositories, and OpenAI gateway in `backend/src/modules/chat/services/chatService.ts`
- **Files Kept Small**: `chatService.ts`, `chatPresenter.ts`, `frontend/components/dashboard/chat-citations.tsx`
- **Planned Extractions**: a parser for raw citation anchors, a deterministic answer-segment builder, and a small shared citation-anchor format helper for prompt/runtime alignment
- **Required Refactor Stories**: remove the token-overlap placement heuristic from `answerPresentationService.ts` before layering in new exact-placement behavior

## Phase 0: Research Decisions

- Use explicit source anchors in the model output tied to retrieval result numbers rather than inferring placement from answer text after generation.
- Keep the public response shape centered on `answer`, `citations`, and `answerSegments` so the frontend can keep its current rendering model.
- Treat malformed or unknown anchors as invalid input to be dropped during normalization rather than guessed or repaired heuristically.
- Keep streaming chunks as plain text in flight and normalize to precise citation placement only on completion.

## Phase 1: Design Outputs

- `research.md` records the anchor-format, normalization, and streaming-finalization decisions.
- `data-model.md` defines retrieved result numbers, raw anchors, normalized citations, and answer segments.
- `contracts/chat-citation-placement.md` documents the completed response contract and the non-goal of exposing raw anchor syntax to the frontend.
- `quickstart.md` captures the TDD-first implementation and verification path for JSON and SSE behavior.

## Implementation Strategy

1. Add failing tests for deterministic citation placement, malformed anchor handling, and streaming/non-streaming parity.
2. Update prompt construction so retrieved contexts receive stable result numbers and the model is instructed to emit a strict citation-anchor format.
3. Introduce a focused parser/normalizer service that converts raw model answers into clean answer text plus exact `answerSegments` and visible citations.
4. Replace heuristic placement in `answerPresentationService.ts` with deterministic parsing and normalization.
5. Wire both JSON and SSE completion paths through the same normalization path without expanding `ChatService` beyond orchestration.
6. Keep frontend rendering compatible with the normalized response and verify the build.

## Testing Strategy

- Backend unit tests for citation-anchor parsing, deduplication, malformed-anchor dropping, and exact answer-segment construction
- Backend unit tests for prompt formatting and stable source numbering
- Backend unit tests for streaming completion parity in `chat-service-streaming.test.ts`
- Backend contract and integration tests for completed chat responses retaining `citations` and `answerSegments` with precise placement
- Targeted frontend build verification to confirm response-shape compatibility

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD is explicit and front-loaded. Pass.
- Stack discipline remains unchanged. Pass.
- No new secrets or persistence systems are introduced. Pass.
- Transport, orchestration, domain, and frontend seams are explicit and remain narrow. Pass.
- No constitution exceptions require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
