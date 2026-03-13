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

Final live verification recorded on 2026-03-13 against the normal Docker stack at `http://localhost:8080` with the 10-document manual corpus:

- document ingest succeeded for all `10/10` documents
- strict profile returned grounded answers for both the rate-limit query and the session-cookie follow-up
- broad profile also returned grounded answers for both checks

Observed shared-stack outcomes:

- document ingest succeeded for all `10/10` documents
- strict profile:
  - rate-limit query: grounded answer, `3` citations including `Rate Limits`
  - session-cookie follow-up: grounded answer, `5` citations including `Session Cookie`
- broad profile:
  - rate-limit query: grounded answer, `3` citations including `Rate Limits`
  - session-cookie follow-up: grounded answer, `5` citations including `Session Cookie`

This confirms the PR meets its intended live retrieval-quality scope on the normal local stack. The correct branch target is `text-embedding-3-small` with `vector(1536)`.
