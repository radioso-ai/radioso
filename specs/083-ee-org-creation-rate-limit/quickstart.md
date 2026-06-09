# Quickstart: EE Organization Creation Rate Limit

## Unit and contract validation

```bash
cd backend
pnpm run test:unit
pnpm run test:contract
```

## OpenAPI regeneration

```bash
cd backend
pnpm run generate:openapi
```

## Backend build

```bash
cd backend
pnpm run build
```

## Integration validation with database

The migrator and concurrent boundary tests are DB-gated and skip unless `INTEGRATION_DATABASE_URL` is set.

```bash
cd backend
INTEGRATION_DATABASE_URL=postgres://... pnpm run test:integration
```

## Manual behavior checks

1. Set `EE_MAX_ORGS_PER_USER_PER_MONTH=1` and enable the EE backend module.
2. Register a new user. Signup must succeed and must not consume the org-creation cap.
3. Create one additional organization through `POST /api/v1/account/accounts`; it should return `201`.
4. Create another organization with the same session; it should return `429` with `error.details.limit`, `used`, `periodStart`, and `resetAt`.
5. Set an override:

   ```bash
   curl -X PUT "$BASE_URL/api/v1/ee/usage-limits/org-creation/users/$USER_ID" \
     -H "Authorization: Bearer $EE_USAGE_ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"monthlyLimit": null}'
   ```

6. Retry organization creation; unlimited override should allow it.
