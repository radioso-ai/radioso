# Implementation Plan: Modular RAG Backend

**Branch**: `001-rag-api-backend` | **Date**: 2026-03-13 | **Spec**: [/Users/dm/code/radioso/specs/001-rag-api-backend/spec.md](/Users/dm/code/radioso/specs/001-rag-api-backend/spec.md)
**Input**: Feature specification from `/Users/dm/code/radioso/specs/001-rag-api-backend/spec.md`

## Summary

Build a greenfield backend service in `/backend` that provides account auth,
single-token API access, document ingestion, retrieval settings, and
conversation-based RAG chat. The implementation will use a contract-first
approach with OpenAPI 3.1 as the shared API reference, PostgreSQL with
`pgvector` as the source of retrieval truth, and modular service boundaries so
transport, orchestration, domain logic, and persistence stay isolated from the
start.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, a recursive text splitter package, cookie parsing/session utilities, password hashing library, Vitest, Supertest  
**Storage**: PostgreSQL 16+ with `pgvector`; filesystem only for local docs such as OpenAPI YAML  
**Testing**: Vitest for unit and integration tests, Supertest for HTTP contract tests, Postgres-backed integration tests for repositories and retrieval flows  
**Target Platform**: Linux or macOS server runtime for local development and containerized deployment  
**Project Type**: web application backend service  
**Performance Goals**: Match spec success criteria: registration and token retrieval under 5 seconds p95, document ingest of 10,000-word payloads available for retrieval within 15 seconds p95, non-streaming chat under 10 seconds p95, streaming first byte under 3 seconds p95  
**Constraints**: Backend-only v1; all secrets in `.env`; one active API token per account; server-managed `HttpOnly` secure session cookie; account-scoped retrieval only; OpenAPI 3.1 YAML at `/backend/openapi.yaml` is the shared API contract source of truth; Docker runtime artifacts under `/infra` must run the backend with PostgreSQL + `pgvector` for local validation  
**Scale/Scope**: Initial MVP for low-to-medium launch traffic with thousands of accounts, hundreds of thousands of chunks, and multi-turn account-scoped conversations in a single backend service

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. PASS
- Backend work includes TDD with failing tests written before implementation. PASS
- Stack remains Node.js for backend and React for frontend. PASS
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS
- LLM provider is GPT-5.2 for AI integrations. PASS
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS
- Customer data handling and auditability are addressed where applicable. PASS
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. PASS

## Project Structure

### Documentation (this feature)

```text
specs/001-rag-api-backend/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── openapi.yaml
├── package.json
├── tsconfig.json
├── src/
│   ├── app/
│   │   ├── config/
│   │   ├── http/
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │   └── presenters/
│   │   └── server/
│   ├── modules/
│   │   ├── auth/
│   │   ├── accounts/
│   │   ├── documents/
│   │   ├── retrieval/
│   │   ├── chat/
│   │   ├── settings/
│   │   └── audit/
│   ├── shared/
│   │   ├── domain/
│   │   ├── infra/
│   │   └── observability/
│   └── db/
│       ├── migrations/
│       └── repositories/
├── tests/
│   ├── contract/
│   ├── integration/
│   └── unit/
infra/
├── backend.Dockerfile
├── docker-compose.yml
└── .env.example
```

**Structure Decision**: Use a dedicated `backend/` service because the repo is
currently greenfield and the feature is backend-only. `src/app/http` owns
transport concerns, `src/modules/*/services` own orchestration,
`src/modules/*/domain` owns chunking and retrieval rules, and `src/db` plus
module repositories own Postgres access. `backend/openapi.yaml` is the
implementation contract artifact, while
`specs/001-rag-api-backend/contracts/openapi.yaml` is the planning draft that
drives the implementation handoff. `/infra` owns container runtime artifacts so
the backend and PostgreSQL + `pgvector` can be started reproducibly for local
development and verification.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*`, request validation
  middleware, auth middleware, and response/stream presenters
- **Orchestration Layer**: `backend/src/modules/auth/services`,
  `backend/src/modules/documents/services`,
  `backend/src/modules/chat/services`, and
  `backend/src/modules/settings/services`
- **Domain Layer**: `backend/src/modules/retrieval/domain` for chunking,
  query rewrite decisions, rerank decisions, prompt assembly, and retrieval
  pipelines; `backend/src/modules/auth/domain` for password/token/session rules
- **Persistence/Integration Layer**: `backend/src/db/repositories`,
  `backend/src/modules/retrieval/infra/vectorSearch.ts`, OpenAI client adapter,
  session store, and audit/event sinks
- **Files Kept Small**: Route handlers remain translation-only; `vectorSearch.ts`
  remains similarity-query-only; config readers remain the sole owner of
  environment variable access; no shared utility file becomes a home for
  feature logic
- **Planned Extractions**: `SessionRepository`, `AccountTokenRepository`,
  `ConversationRepository`, `DocumentRepository`, `ChunkRepository`,
  `RetrievalSettingsRepository`, `EmbeddingGateway`, `ChatGateway`,
  `Chunker`, `PromptBuilder`, `QueryRewriteService`, `RerankService`
- **Required Refactor Stories**: None before implementation because this is a
  greenfield backend area

## Phase 0: Research Outcomes

- Session model: opaque server-managed session IDs in `HttpOnly` secure cookies
  backed by Postgres session rows
- API token model: one active `radioso_*` token per account, stored hashed in
  Postgres and returned only to an authenticated session holder
- Streaming model: Server-Sent Events for streamed chat responses
- Validation model: runtime schema validation at the transport boundary with
  Zod
- API contract model: OpenAPI 3.1 YAML used as the machine- and human-readable
  source of truth
- Retrieval model: recursive chunking with overlap, embeddings via env-selected
  vector model, optional query rewrite and rerank via GPT-5.2 chat model

## Phase 1: Design Artifacts

- `research.md` captures key decisions and rejected alternatives
- `data-model.md` defines relational entities, validation rules, and lifecycle
  transitions
- `contracts/openapi.yaml` defines the planning contract for auth, token,
  document, chat, and settings endpoints
- `quickstart.md` defines local setup, environment variables, migration order,
  Docker startup, and test execution flow
- `backend/openapi.yaml` will be created from the approved contract draft during
  implementation before route handlers are considered complete

## Phase 2: Implementation Strategy

1. Establish backend scaffolding, configuration, lint/test commands, and
   Postgres connectivity.
2. Write failing contract and integration tests for registration, login,
   session cookie handling, token retrieval, settings, document ingestion, and
   chat.
3. Implement auth and account persistence boundaries first because every other
   API depends on them.
4. Implement document ingestion pipeline next: normalization, chunking,
   embeddings, persistence, and retrieval readiness.
5. Implement conversation-aware chat orchestration with vector search, optional
   rewrite/rerank, prompt assembly, and streaming/non-streaming responses.
6. Add `/infra` Docker runtime artifacts for the backend and PostgreSQL +
   `pgvector`, including health validation.
7. Add audit events, observability hooks, `.env.example`, and final contract
   alignment checks.

## Post-Design Constitution Check

- Spec remains the implementation gate. PASS
- TDD remains mandatory and is reflected in the implementation order. PASS
- Stack remains Node.js + PostgreSQL + `pgvector` + GPT-5.2. PASS
- Secrets remain `.env`-driven, including chat model, vector model, and OpenAI key. PASS
- Module seams remain explicit and isolate transport/orchestration/domain/persistence. PASS
- No responsibility-limited file is asked to absorb unrelated concerns. PASS

## Complexity Tracking

No constitution violations or justified exceptions are required for this plan.
