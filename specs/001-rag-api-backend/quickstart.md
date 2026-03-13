# Quickstart: Modular RAG Backend

## 1. Prepare the backend workspace

Create the backend service under `/Users/dm/code/hivec/backend` with:

- TypeScript on Node.js 22
- Express HTTP server
- PostgreSQL connectivity through `pg`
- OpenAI SDK integration
- Vitest and Supertest for TDD

## 2. Create environment variables

Add these values to `/Users/dm/code/hivec/backend/.env`:

```env
PORT=8080
DATABASE_URL=postgres://...
INTEGRATION_DATABASE_URL=postgres://...
OPENAI_API_KEY=...
OPENAI_CHAT_MODEL=gpt-5.2
OPENAI_VECTOR_MODEL=text-embedding-3-small
SESSION_COOKIE_SECRET=...
```

Mirror non-secret placeholders in `/Users/dm/code/hivec/backend/.env.example`.

## 3. Provision PostgreSQL

Ensure PostgreSQL has:

- the `pgvector` extension enabled
- migration support for accounts, sessions, account tokens, documents, chunks,
  retrieval settings, conversations, messages, and audit events

## 4. Contract-first workflow

1. Start from `/Users/dm/code/hivec/specs/001-rag-api-backend/contracts/openapi.yaml`.
2. Copy or promote the approved contract to `/Users/dm/code/hivec/backend/openapi.yaml`.
3. Write failing contract tests for:
   - `POST /api/v1/auth/register`
   - `POST /api/v1/auth/login`
   - `GET /api/v1/account/token`
   - `GET /api/v1/settings/retrieval`
   - `PUT /api/v1/settings/retrieval`
   - `POST /api/v1/document/`
   - `POST /api/v1/chat/`

## 5. Recommended implementation order

1. Configuration, logger, server bootstrap, and health plumbing
2. Accounts, password hashing, sessions, and single account token retrieval
3. Retrieval settings repository and endpoints
4. Document normalization, chunking, embeddings, and vector persistence
5. Conversations, messages, vector search, prompt building, and chat streaming
6. Audit events, error mapping, and observability

## 6. Test order

1. Contract tests for auth/session/token endpoints
2. Integration tests for account-scoped persistence rules
3. Unit tests for chunker overlap logic and settings validation
4. Integration tests for document ingestion pipeline
5. Contract and integration tests for chat, including SSE streaming
6. Persistence integration tests against a real Postgres + `pgvector` instance via `INTEGRATION_DATABASE_URL`

## 7. Validation commands

Run from `/Users/dm/code/hivec/backend`:

```bash
npm test
npm run build
npm run test:persistence
```

`npm run test:persistence` requires a reachable Postgres database with
`pgvector` available through `INTEGRATION_DATABASE_URL`.

## 8. Validation status

- `npm test`: passed on 2026-03-13
- `npm run build`: passed on 2026-03-13
- `npm run test:persistence`: not executed successfully on 2026-03-13 because no reachable local Postgres instance was available in this workspace

## 9. Done criteria for implementation

- OpenAPI contract and handlers match
- `.env.example` documents all required configuration
- failing tests are written before implementation for each module
- account-scoped retrieval leakage tests pass
- streaming and non-streaming chat paths pass contract tests
