# Quickstart: Universal Retrieval Quality Upgrade

## 1. Prepare the backend environment

From `/private/tmp/hivec-improve-rag-pipeline/backend`:

1. Ensure `.env` contains:
   - `DATABASE_URL`
   - `OPENAI_API_KEY`
   - `OPENAI_CHAT_MODEL`
   - `OPENAI_VECTOR_MODEL`
   - `SESSION_COOKIE_SECRET`
2. Start PostgreSQL with `pgvector` available.
3. Start the backend service.

The repeatable benchmark corpus for automated validation lives under:

- `/private/tmp/hivec-improve-rag-pipeline/backend/tests/fixtures/retrieval-quality/`
- `/private/tmp/hivec-improve-rag-pipeline/backend/tests/support/retrievalFixtures.ts`

## 2. Validate the unchanged public contract

The public contract for:

- `PUT /api/v1/settings/retrieval`
- `POST /api/v1/chat/`

must remain unchanged while internal retrieval behavior improves.

Run:

```bash
cd /private/tmp/hivec-improve-rag-pipeline/backend
npm test
```

## 3. Exercise representative retrieval profiles

Use one representative document corpus per account and validate all of the following profiles:

- a strict profile with high precision expectations
- a moderate profile for balanced retrieval
- a broad profile with high candidate depth and final narrowing

The default automated benchmark uses:

- direct-answer questions
- referential follow-up questions
- noisy-corpus disambiguation questions
- safe fallback questions

For each profile:

1. Register an account and obtain its bearer token.
2. Ingest representative documents containing:
   - direct-answer passages
   - overlapping topical noise
   - referential follow-up opportunities
3. Update retrieval settings for that account.
4. Run chat prompts covering:
   - direct known-answer questions
   - referential follow-up questions
   - noisy-corpus disambiguation
   - empty or fallback-triggering queries

## 4. Validate retrieval-quality outcomes

Confirm that:

- grounded answers include at least one relevant citation when the answer exists in the corpus
- referential follow-up questions resolve correctly without manual restatement
- irrelevant citations are materially reduced versus the current baseline
- rewrite or rerank failures still produce a safe grounded-or-fallback outcome

## 5. Validate observability

Confirm that the request-level execution record shows:

- whether query rewrite was applied, skipped, or fell back
- whether reranking was applied, skipped, or fell back
- first-pass candidate counts
- normalized candidate count
- final prompt context count

## 6. Validation commands

```bash
cd /private/tmp/hivec-improve-rag-pipeline/backend
npm test
npm run build
npm run test:persistence
```

`npm run test:persistence` still requires a reachable PostgreSQL instance with `pgvector`.

## 7. Latest Validation Snapshot

Latest automated validation recorded on 2026-03-13:

- `npm test` passed with `12` test files passed, `38` tests passed, and `1` persistence file skipped because no integration database was configured
- `npm run build` passed
- `npm run test:persistence` was executed and skipped because `INTEGRATION_DATABASE_URL` was not set for this worktree session

The current implementation keeps the public API unchanged, emits retrieval diagnostics only through audit metadata, and validates retrieval behavior through direct-answer, follow-up, noisy-corpus, and fallback benchmark fixtures.

Latest live verification recorded on 2026-03-13 against `http://localhost:8080` with the 10-document manual corpus:

- document ingest succeeded for all `10/10` documents
- the broad profile remained partially usable
- the strict profile still returned the safe no-information answer for known-answer queries
- the recreated live backend emitted retrieval diagnostics showing zero first-pass candidates under the strict threshold and rewrite/rerank fallback on follow-up queries

Observed live outcomes:

- strict profile:
  - rate-limit query: fallback answer, `0` citations
  - session-cookie follow-up: fallback answer, `0` citations
- broad profile:
  - rate-limit query: correct grounded answer, `3` citations
  - session-cookie follow-up: fallback answer, `0` citations on the recreated backend

This means the branch improves structure, tests, and observability, but does not yet meet the intended live retrieval-quality outcome for strict profiles or reliable follow-up rescue.

Follow-up isolated verification recorded on 2026-03-13 against `http://localhost:8091` using the worktree backend directly and a temporary `hivec_ragtest` database with matching `text-embedding-3-large` embeddings:

- document ingest succeeded for all `10/10` documents
- strict profile returned a grounded rate-limit answer with citations
- strict follow-up returned a grounded session-cookie answer with citations
- broad profile also returned grounded answers for both checks

Observed isolated outcomes:

- strict profile:
  - rate-limit query: grounded answer, `3` citations including `Rate Limits`
  - session-cookie follow-up: grounded answer, `3` citations including `Session Cookie`
- broad profile:
  - rate-limit query: grounded answer, `3` citations including `Rate Limits`
  - session-cookie follow-up: grounded answer, `3` citations including `Session Cookie`

This isolates the remaining operational issue to environment drift in the shared Docker stack: the local persistent database still uses `vector(1536)`, while this worktree branch expects `vector(3072)`. With a matching database and embedding model, the retrieval changes improve live known-answer and follow-up behavior materially.
