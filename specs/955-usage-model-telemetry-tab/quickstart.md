# Quickstart: Verify Usage Details

1. Start the stack with `./run-dev.sh` and sign in as an active account member.
2. Open **Usage** and select **AI usage**.
3. In **Messages**, choose a date range containing a visitor turn. Confirm the
   row shows model input, reasoning coverage, completion/visible-output
   semantics, and any query-embedding subtotal without rendering the message
   text.
4. In **Internal operations**, confirm that metadata generation, embeddings,
   operator test/replay, eval, agent setup, directive drafting, and directive
   coherence are distinct from visitor messages.
5. Select one workspace, refresh the page, and confirm the filter remains
   selected. Use **Load more** in each view when results exceed one page.
6. Run focused verification:

```bash
cd backend
pnpm exec vitest run tests/unit/model-inference-pipeline.test.ts \
  tests/integration/usage-ledger-migration.integration.test.ts \
  tests/contract/usage-details.contract.test.ts \
  tests/integration/usage-details.integration.test.ts

cd ../frontend
pnpm exec vitest run tests/unit/account-api.test.ts tests/unit/usage-details.test.ts
pnpm exec playwright test tests/e2e/usage-details.spec.ts
```

7. Regenerate and check schema/API artifacts:

```bash
pnpm --dir backend run db:schema
pnpm --dir backend run db:types
pnpm --dir backend run generate:openapi
pnpm --dir typescript-sdk run sync
pnpm --dir packages/radioso-mcp-server run sync:openapi
pnpm run check:api-contracts
```
