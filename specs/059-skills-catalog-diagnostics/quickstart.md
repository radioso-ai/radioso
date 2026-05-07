# Quickstart: Skills Catalog Diagnostics

## Validation

From `backend/`:

```bash
npm test -- --run tests/unit/skills-catalog.test.ts tests/unit/capability-policy.test.ts
npm run test:contract -- --run tests/contract/skills-catalog.contract.test.ts tests/contract/openapi.contract.test.ts tests/contract/sdk-openapi.contract.test.ts
npm run build
```

From `typescript-sdk/`:

```bash
npm run build
```

## Manual API Check

With a valid workspace session or workspace token:

```bash
curl -s http://localhost:8080/api/v1/skills
curl -s http://localhost:8080/api/v1/skills/retrieval.answer
curl -s http://localhost:8080/api/v1/skills/not.real
```

Expected behavior:

- the list response returns built-in skill metadata
- the detail response returns one canonical skill entry
- the unknown skill response returns `skill_not_found`

## Message-Queue Impact

No queue validation is required beyond documenting that the feature is read-only catalog metadata and does not affect document worker dispatch, AMQP payloads, retry behavior, or queue tests.
