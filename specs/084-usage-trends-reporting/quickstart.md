# Quickstart: Usage Trends Reporting

## Backend

Run focused backend checks:

```bash
cd backend
pnpm test -- tests/unit/usage-trends-periods.test.ts tests/unit/usage-trends-service.test.ts
pnpm run test:contract -- usage-trends.contract.test.ts openapi.contract.test.ts
```

Run the database-backed scenarios only when a database is available:

```bash
cd backend
INTEGRATION_DATABASE_URL=postgres://... pnpm run test:integration -- usage-trends.integration.test.ts
```

## API Smoke Test

With a browser session cookie:

```bash
curl -s \
  -H "Cookie: radioso_session=<session>" \
  "http://localhost:8080/api/v1/account/usage-trends?from=2026-06-01&to=2026-06-07&granularity=day"
```

Expected result:

- `200` for any active account member.
- A continuous bucket list from June 1 through June 7 UTC.
- Counts and token aggregates only.

## Frontend

Run focused frontend checks:

```bash
cd frontend
pnpm test -- tests/unit/usage-trends.test.ts
pnpm run test:e2e -- usage-trends.spec.ts
```

The Usage dashboard should let a member change date range, granularity, workspace filter, and agent filter. The current EE quota summary remains separate when EE usage limits are enabled.
