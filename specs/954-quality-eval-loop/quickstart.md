# Quickstart: Quality Resolution and Eval Learning Loop

## Focused backend validation

```bash
cd backend
pnpm exec vitest run tests/unit/quality-resolution.test.ts tests/unit/quality-routes.test.ts
pnpm exec vitest run tests/unit/eval-message-case-service.test.ts
pnpm exec vitest run tests/integration/quality-triage.integration.test.ts
pnpm exec vitest run tests/integration/eval-repository.integration.test.ts
pnpm run test:contract
```

Confirm tests were first observed failing before their production slice.

## Contract generation

```bash
pnpm --dir backend run generate:openapi
pnpm --dir typescript-sdk run sync
pnpm --dir packages/radioso-mcp-server run sync:openapi
pnpm run check:api-contracts
```

## Dashboard validation

```bash
cd frontend
pnpm test
pnpm exec playwright test tests/e2e/quality-resolution.spec.ts
```

Exercise both Quality and Needs Attention: terminal reason validation,
recoverable errors preserving the note, stale-version recovery, accessible
announcement/focus, Add/Open Eval, timestamped pass evidence, URL reason
restoration, and breakdown click-through.

## Schema and broad validation

```bash
pnpm --dir backend run db:schema
pnpm --dir backend run db:types
pnpm run ci:local -- origin/main
```

Inspect logs and transition rows to verify no resolution note, prompt, answer,
document content, credential, token, or cookie is recorded.
