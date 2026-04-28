# Quickstart: Structured Lexical Query Plans

## Validation Scenarios

1. Run unit tests for lexical alternative normalization:

   ```bash
   cd backend
   npm run test:unit -- tests/unit/lexical-query-plan.test.ts
   ```

2. Run query rewrite tests that prove raw OR-style lexical strings become separate existing retrieval subqueries:

   ```bash
   cd backend
   npm run test:unit -- tests/unit/query-rewrite-subqueries.test.ts
   ```

3. Run lexical search tests that prove phrase and web-search-style query parsing is compiled by the PostgreSQL adapter:

   ```bash
   cd backend
   npm run test:unit -- tests/unit/hybrid-retrieval-search.test.ts
   ```

4. Run retrieval pipeline stage tests to confirm existing stage contracts remain source-compatible:

   ```bash
   cd backend
   npm run test:unit -- tests/unit/retrieval-pipeline-stages.test.ts
   npm run typecheck
   ```

## Expected Behavior

- A model lexical query like `"forgot password" OR "reset token"` is normalized into separate bounded lexical alternatives.
- Existing retrieval branches execute the alternatives without changing retrieval pipeline stage interfaces.
- Invalid or empty alternatives fall back to the original lexical query.
- PostgreSQL lexical search uses safer full-text query parsing for exact phrases and web-style query syntax where supported.
