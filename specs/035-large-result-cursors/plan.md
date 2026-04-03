# Implementation Plan: High-Cardinality Cursor Hardening

**Branch**: `borohhov/large-result-cursors` | **Date**: 2026-04-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/035-large-result-cursors/spec.md`

## Summary

Harden every user-generated high-cardinality route that still risks unbounded
reads, then migrate the hot collection traversal paths from `limit + offset` to
opaque cursor-based continuation. The work keeps transport handlers thin,
pushes traversal policy into focused read services and repositories, and lands
contract, frontend, and documentation updates together so the bounded strategy
becomes durable rather than ad hoc.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router  
**Storage**: PostgreSQL 16 with `pgvector`; existing documents, conversations, messages, audit events, and search history tables  
**Testing**: Vitest, Supertest, contract and integration coverage in `backend/tests`, frontend unit coverage where view logic changes  
**Target Platform**: Web application with authenticated dashboard and anonymous public chat flows  
**Project Type**: Web application  
**Performance Goals**: Eliminate unbounded collection reads, avoid deep offset degradation on hot list paths, and preserve responsive list/detail browsing under representative large datasets  
**Constraints**: Keep routes transport-only, preserve existing sort semantics, maintain code-first OpenAPI ownership, and avoid full-collection reloads after list actions  
**Scale/Scope**: Documents, authenticated chat history, anonymous chat history, document search history, and conversation message windows

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated.
- Customer data handling and auditability are addressed where applicable.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work.

## Project Structure

### Documentation (this feature)

```text
specs/035-large-result-cursors/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/openapi/
│   ├── app/http/routes/
│   ├── db/repositories/
│   └── modules/
│       ├── chat/services/
│       └── documents/services/
├── openapi.yaml
├── openapi.json
└── tests/

frontend/
├── app/
├── components/dashboard/
└── lib/
```

**Structure Decision**: Backend contract and route validation remain in
`backend/src/app/http/routes/` and `backend/src/app/http/openapi/`.
Collection traversal orchestration remains in focused chat and document read
services. Cursor-aware SQL remains in repositories. Frontend cursor state and
navigation remain in `frontend/lib/api.ts`, route-state helpers, and the
collection views that already own document/history presentation.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/documentRoutes.ts`
  - `backend/src/app/http/routes/chatRoutes.ts`
  - `backend/src/app/http/routes/publicChatRoutes.ts`
- **Orchestration Layer**:
  - `backend/src/modules/documents/services/documentIngestionService.ts`
  - `backend/src/modules/documents/services/documentSearchHistoryService.ts`
  - `backend/src/modules/chat/services/chatHistoryService.ts`
- **Domain Layer**:
  - new shared cursor contract/codec under a focused module
  - bounded route inventory artifact in the feature docs
- **Persistence/Integration Layer**:
  - `backend/src/db/repositories/documentRepository.ts`
  - `backend/src/db/repositories/conversationRepository.ts`
  - `backend/src/db/repositories/messageRepository.ts`
  - any document-search-history repository used by the documents search history service
- **Files Kept Small**:
  - route files listed above must remain transport-only
  - `frontend/components/dashboard/documents-view.tsx` must remain a view/controller, not absorb backend cursor encoding rules
  - `frontend/lib/api.ts` must remain the HTTP client boundary, not a mixed state manager
- **Planned Extractions**:
  - shared cursor codec
  - cursor pagination types shared by backend contracts and frontend client
  - route inventory notes in this feature package
- **Required Refactor Stories**:
  - remove or deprecate unbounded repository methods still reachable from hot paths
  - isolate any hidden full-history reads discovered in document search history or message detail flows before cursor rollout

## Route Inventory

| Route / Flow | Current State | Target State | Owner |
|--------------|---------------|--------------|-------|
| `GET /api/v1/documents` | bounded API, offset-based, old unbounded repo method still exists | cursor-based bounded summaries | documents service + document repository |
| `GET /api/v1/chat/history` | bounded API, offset-based | cursor-based bounded summaries | chat history service + conversation repository |
| `GET /api/v1/public/chat/:token` | bounded API, offset-based | cursor-based bounded summaries | chat history service + conversation repository |
| `GET /api/v1/document/search/history` | bounded API, offset-based | cursor-based bounded summaries | document search history service + search history repository |
| `GET /api/v1/chat/history/:conversationId` | bounded message window, offset-based | cursor-based older-message windows | chat history service + message repository |
| `GET /api/v1/public/chat/:token/history/:conversationId` | bounded message window, offset-based | cursor-based older-message windows | chat history service + message repository |

## Delivery Phases

### Phase 0 - Inventory And Failure-Mode Audit

1. Enumerate every user-generated collection-returning route and the repository
   method it reaches.
2. Confirm which endpoints already enforce bounded list shapes and which still
   rely on unbounded repository methods or deep offset traversal.
3. Record the route inventory and explicit anti-regression rules in the feature
   docs.

### Phase 1 - Remove Remaining Unbounded Hot Paths

1. Add failing backend tests proving the current hot collection flows must not
   call unbounded repository reads.
2. Replace any remaining hot-path use of `listByWorkspaceId`,
   `listByAnonymousSession`, and similar unbounded methods with dedicated bounded
   summary/window reads.
3. Confirm list responses exclude full document bodies and other oversized
   payload fields not needed for browsing.

### Phase 2 - Cursor Contract Design

1. Define an opaque cursor shape using stable sort keys:
   - Documents: `(created_at DESC, id DESC)`
   - Conversation summaries: `(updated_at DESC, id DESC)`
   - Message windows: `(created_at DESC, id DESC)` while exposing oldest/newest
     semantics clearly to the client
2. Add a shared cursor codec and validation layer.
3. Update `backend/src/app/http/openapi/document.ts` with cursor-based request
   and response schemas.
4. Regenerate `backend/openapi.yaml` and `backend/openapi.json`.

### Phase 3 - Repository Migration To Keyset Reads

1. Add cursor-aware repository methods for:
   - documents
   - authenticated conversations
   - anonymous conversations
   - document search history
   - conversation messages
2. Replace `LIMIT/OFFSET` hot-path traversal with seek predicates using the
   chosen sort key plus a deterministic tie-breaker.
3. Add composite indexes aligned with those seek predicates where missing.
4. Preserve existing sort semantics and fail safely on invalid cursor input.

### Phase 4 - Service And Route Migration

1. Update chat and document read services to accept cursor inputs and emit
   `nextCursor` / `hasMore` metadata.
2. Keep route handlers transport-only by performing cursor parsing and response
   shaping only at the edge.
3. Remove or deprecate offset-first code paths from normal product flows once
   frontend migration is complete.

### Phase 5 - Frontend Cursor Adoption

1. Update `frontend/lib/api.ts` to call the new cursor contracts.
2. Update:
   - `frontend/components/dashboard/documents-view.tsx`
   - chat history view
   - anonymous chat context and public history flow
   - any conversation detail drawer or message window UI
3. Replace page-number assumptions with continuation-driven navigation where
   necessary.
4. Preserve existing empty, loading, and action-refresh behavior without full
   collection reloads.

### Phase 6 - Verification And Documentation

1. Add backend contract, integration, and representative large-data tests for
   each hardened route.
2. Validate cursor correctness under timestamp ties plus concurrent insert/delete
   churn.
3. Update operator/developer docs describing the route inventory and cursor
   traversal behavior.
4. Record any intentionally deferred low-cardinality paths with justification.

## Testing Strategy

- Backend TDD for each route conversion: failing tests first, then repository
  and service implementation.
- Contract tests for every changed HTTP endpoint in the code-first OpenAPI
  surface.
- Integration tests around large representative datasets, especially the
  document-list failure mode already captured by the existing scale spec.
- Targeted frontend tests for cursor navigation helpers and list refresh logic.

## Risks And Mitigations

- **Risk**: Existing UI expects exact page counts and `total` semantics.
  **Mitigation**: Keep exact totals temporarily where cheap enough, but make
  cursor traversal the primary navigation primitive and decouple page numbering
  from hot paths.
- **Risk**: Message windows can duplicate or skip rows when timestamps tie.
  **Mitigation**: Encode the timestamp plus stable `id` tie-breaker in the
  cursor and test the boundary conditions explicitly.
- **Risk**: Offset and cursor contracts coexist during migration.
  **Mitigation**: Migrate one surface at a time and remove old hot-path callers
  as soon as the frontend no longer depends on them.

