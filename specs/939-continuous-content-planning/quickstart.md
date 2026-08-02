# Quickstart: Continuous Content Planning

## Prerequisites

- Node.js 24 and pnpm 10.33
- PostgreSQL 16 with pgvector (the repository Docker test helpers provide this)
- Workspace dependencies installed with `pnpm install --frozen-lockfile`
- Provider credentials only for live fallback embedding/enrichment tests; deterministic
  unit/integration fixtures use stubs

## Implementation order

1. Extend the neutral conversation interaction contract and both turn-understanding
   parsers/prompts. Prove malformed output becomes `unresolved` and lifecycle overrides
   win without text heuristics.
2. Expose semantic vector envelopes from deterministic and agentic retrieval. Prove
   multi-subquery identity/space/vector parity and no extra provider call.
3. Add migration 134, regenerate Kysely/schema artifacts, and implement transactional
   intake repositories/ports.
4. Add pure topic, trend, opportunity, ranking, action, and lifecycle policies with
   deterministic fixtures before worker persistence/orchestration.
5. Implement worker claims, fallback embeddings, assignment, merge/retirement,
   bootstrap/reprojection, corpus evidence, enrichment, and observability.
6. Implement the Quality evidence port and Content Planning list/detail/member-turn
   APIs, then lock/generate public contracts.
7. Implement the frontend against the locked API contract, then integrate Quality and
   Knowledge handoffs.
8. Update docs and run focused/broad validation plus review loops.

## Focused backend checks

```bash
cd backend
pnpm run build:workspace-deps
pnpm exec vitest run \
  tests/unit/conversation-interaction-role.test.ts \
  tests/unit/content-planning-domain.test.ts \
  tests/unit/content-planning-worker.test.ts \
  tests/unit/content-planning-routes.test.ts \
  tests/unit/retrieval-semantic-vector-envelope.test.ts
pnpm exec vitest run \
  tests/integration/content-planning-persistence.integration.test.ts \
  tests/integration/content-planning-read-model.integration.test.ts \
  tests/integration/content-planning-deletion.integration.test.ts \
  --no-file-parallelism --testTimeout=30000
pnpm run test:contract
pnpm run build
```

## Schema and generated contracts

```bash
pnpm --dir backend run db:schema
pnpm --dir backend run db:types
pnpm --dir backend run generate:openapi
pnpm --dir typescript-sdk run sync
pnpm --dir packages/radioso-mcp-server run sync:openapi
pnpm run check:api-contracts
```

## Frontend checks

```bash
cd frontend
pnpm test -- tests/unit/api-content-plan.test.ts tests/unit/dashboard-routes.test.ts
pnpm run test:e2e -- content-plan.spec.ts nav-sidebar.spec.ts
pnpm run lint
pnpm run build
```

## Deterministic clustering fixture

The committed fixture contains at least 160 observations over at least eight topics,
three non-English languages, paraphrases, contextual fragments, multi-intent turns,
outliers, unrelated singletons, and prompt-injection text. Run:

```bash
cd backend
pnpm exec vitest run tests/unit/content-planning-clustering-fixture.test.ts
```

The gate requires pairwise F1 `>=0.85` overall and `>=0.80` for cross-language
equivalence pairs. The fixture uses deterministic vectors; it does not make a live
provider request in normal CI.

## Manual local walkthrough

```bash
./run-dev.sh
```

1. Create or select a workspace with an agent and knowledge documents.
2. Submit substantive, follow-up, social/control, clarification, multi-intent, grounded,
   degraded, unsupported, and unevaluated visitor turns.
3. Keep the document worker running and open Activity → Content plan.
4. Confirm the summary, singular Recommended next, opportunities/all-interests views,
   emerging evidence, freshness strip, and detail evidence reconcile with source turns.
5. Exercise View answers, source conversation, related document, and question-only
   Write document handoffs.
6. Stop/restart the worker, repeat a projection claim, delete a source message, and
   change embedding space; verify idempotency, deletion, and coherent reprojection states.

## Final gate

```bash
pnpm run ci:local -- --all
```

Record focused tests, schema/type checks, generated-contract checks, clustering fixture
metrics, performance fixture, frontend viewport/accessibility evidence, and local CI in
the pull-request body.
