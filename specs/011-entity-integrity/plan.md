# Implementation Plan: Generalized Entity Integrity in Retrieval Grounding

**Branch**: `011-entity-integrity` | **Date**: 2026-03-16 | **Spec**: [/Users/dm/code/hivec-entity-integrity/specs/011-entity-integrity/spec.md](/Users/dm/code/hivec-entity-integrity/specs/011-entity-integrity/spec.md)
**Input**: Approved feature specification from `/specs/011-entity-integrity/spec.md`

## Summary

Preserve entity integrity in retrieval-grounded answers by attaching generalized subject identity to chunk search text during ingestion, interpreting single-entity versus correction versus comparison queries, applying subject-aware candidate guards in retrieval, and blocking unsafe blended answers when ambiguity remains unresolved.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js backend  
**Primary Dependencies**: Express, OpenAI SDK, pg, Zod, Vitest, Supertest  
**Storage**: PostgreSQL with pgvector for production; in-memory repositories in test support  
**Testing**: Vitest unit and integration tests, TypeScript build  
**Target Platform**: Backend API service  
**Project Type**: Web application with `backend/` and `frontend/` workspaces  
**Performance Goals**: Preserve existing retrieval latency characteristics while adding deterministic subject checks in the retrieval pipeline  
**Constraints**: Must remain provider-agnostic at the feature level, must tolerate rerank fallback, must keep chat orchestration responsibility-limited  
**Scale/Scope**: Backend retrieval and chat pipeline only; no new UI workflows and no source-data repair work

## Constitution Check

*GATE: Passed before implementation and re-checked after delivery.*

- Spec exists and is approved before implementation: satisfied.
- Backend work includes TDD with failing tests written before implementation: satisfied.
- Stack remains Node.js for backend and React for frontend: satisfied.
- Database remains PostgreSQL with `pgvector`: satisfied.
- LLM provider remains GPT-5.2 by default: satisfied.
- Secrets/config hygiene changes required: none.
- Customer data handling remains unchanged; no new sensitive data exposure added.
- Module boundaries remain explicit between ingestion, retrieval, and chat orchestration: satisfied.
- Existing responsibility-limited files were kept small by introducing focused retrieval services: satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/011-entity-integrity/
├── checklists/
│   └── requirements.md
├── plan.md
├── spec.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── chat/services/
│   │   ├── documents/services/
│   │   └── retrieval/
│   │       ├── domain/
│   │       └── services/
│   └── app/server/
└── tests/
    ├── integration/
    ├── support/
    └── unit/
```

**Structure Decision**: Keep document ingestion responsible for enriching chunk search text, keep retrieval services responsible for subject inference and candidate/context guarding, and keep chat service limited to orchestration plus the final unsafe-blend refusal path.

## Module Ownership & Seams

- **Transport Layer**: Existing HTTP routes and presenters remain unchanged.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts` coordinates retrieval and answer completion, but delegates entity decisions to retrieval output.
- **Domain Layer**: New focused retrieval services own subject extraction, query intent parsing, and entity integrity decisions.
- **Persistence/Integration Layer**: Existing document/chunk repositories and vector/lexical search ports remain unchanged.
- **Files Kept Small**: `chatService.ts`, `promptBuilder.ts`, and `documentIngestionService.ts` receive only wiring-level changes.
- **Planned Extractions**: `subjectIdentityService.ts`, `entityQueryIntentService.ts`, and `entityIntegrityService.ts`.
- **Required Refactor Stories**: None beyond the focused service extraction completed in this feature.

## Delivery Notes

### Phase 1: Ingestion Anchoring

- Derive a generalized document subject from heading/title context.
- Propagate subject and local section context into each chunk’s search text.

### Phase 2: Retrieval Guards

- Parse query intent into single-entity, correction, comparison, or generic modes.
- Apply subject-aware candidate guards before the merged candidate cap.
- Resolve reranked contexts by subject agreement for single-entity and correction turns.

### Phase 3: Answer Safety

- Add a final refusal path in chat orchestration for unresolved multi-entity ambiguity.
- Strengthen prompt instructions to avoid cross-subject fact fusion.

### Phase 4: Validation

- Add unit tests for subject anchoring and entity intent/guard behavior.
- Add integration tests that exercise single-entity, correction, and comparison retrieval behavior.
- Run `npm run build`, `npm run test:unit`, and focused chat integration tests.
