# Quickstart: Retrieval Module Boundaries

Run these checks from the repository root after implementation.

## 1. Boundary lint

```bash
cd backend
npm run lint:boundaries
```

Expected result: the command passes after production imports outside retrieval use approved retrieval root entry points such as `backend/src/modules/retrieval/public.ts`, `backend/src/modules/retrieval/composition.ts`, or `backend/src/modules/retrieval/llmAdapters.ts`.

To validate the failure mode during development, temporarily add a direct production import from a file outside retrieval to a retrieval domain, service, or infrastructure file. `npm run lint:boundaries` must fail with a boundary violation. Remove the temporary import before committing.

## 2. Backend build

```bash
cd backend
npm run build
```

Expected result: OpenAPI generation and TypeScript compilation pass with no runtime contract changes.

## 3. Composition validation

```bash
cd backend
npm run test:composition
```

Expected result: default composition tests continue to pass.

## 4. Focused tests for touched areas

Run focused tests when import migration touches the corresponding area. Use exact Vitest files so the package-level `test:unit` script does not expand back to the full unit directory.

```bash
cd backend
npx vitest run tests/unit/retrieval-pipeline-stages.test.ts tests/unit/retrieval-settings-and-chunking.test.ts tests/unit/retrieval-trace.test.ts tests/unit/retrieval-execution-telemetry-service.test.ts tests/unit/hybrid-retrieval-search.test.ts tests/unit/hybrid-retrieval-info.test.ts tests/unit/candidate-retrieval-branches.test.ts tests/unit/query-rewrite-subqueries.test.ts tests/unit/llm-provider-registry.test.ts tests/unit/structured-chunking.test.ts
npx vitest run tests/unit/chat-service-streaming.test.ts tests/unit/chat-history-service.test.ts tests/unit/chat-bootstrap-service.test.ts tests/unit/chat-presenter.test.ts tests/unit/chat-retrieval.domain.test.ts tests/unit/conversation-intent-snapshot.test.ts tests/unit/chat-execution-policy.test.ts
npx vitest run tests/unit/document-ingestion.test.ts tests/unit/document-processing-worker-runtime.test.ts tests/unit/document-import-service.test.ts tests/unit/document-deletion.test.ts tests/unit/document-search-history-service.test.ts tests/unit/document-subject-search-text.test.ts tests/unit/ingestion-settings.test.ts
```

Expected result: touched retrieval, chat, and document behavior remains unchanged.

## 5. CI check

Confirm `.github/workflows/ci.yml` runs the backend boundary lint target after backend dependency installation. Pull requests with direct production imports from retrieval internals should fail CI before merge.
