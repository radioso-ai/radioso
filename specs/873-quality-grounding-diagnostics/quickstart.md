# Quickstart: Validate Quality Grounding Diagnostics

## Focused backend checks

```bash
cd backend
pnpm exec vitest run tests/unit/chat-turn-lifecycle.test.ts tests/unit/quality-routes.test.ts
pnpm exec vitest run tests/integration/chat/postgres-assistant-turn-persistence.integration.test.ts tests/integration/quality-turns.integration.test.ts tests/integration/message-grounding-diagnostics-migration.integration.test.ts
```

Validate:

- a new grounded/degraded/no-support snapshot is written atomically;
- absent summaries leave all columns null;
- API objects are complete or null;
- verdict and boolean filters preserve totals, ordering, and existing filters;
- stats and signal results do not change.

## Contract synchronization

```bash
pnpm --dir backend run generate:openapi
pnpm --dir typescript-sdk run sync
pnpm --dir packages/radioso-mcp-server run sync:openapi
pnpm run check:api-contracts
```

## Frontend checks

```bash
cd frontend
pnpm test -- tests/unit/api-quality.test.ts tests/unit/dashboard-routes.test.ts
pnpm run test:e2e -- quality-health.spec.ts
pnpm run lint
```

Verify the table shows:

- `2 of 2 claims sourced` for healthy evidence;
- separate non-zero unsourced and invalid-source warnings;
- `No supported claims` for zero-claim no-support;
- no evidence line for null diagnostics.

Open Filter → Evidence, select verdicts and the two issue toggles, reload the
page, remove each applied pill, and confirm signal presets clear evidence state.

## Broad checks

```bash
pnpm --dir backend run build
pnpm --dir frontend run build
pnpm --dir typescript-sdk run build
pnpm --dir packages/radioso-mcp-server run build
pnpm run ci:local -- origin/main
```
