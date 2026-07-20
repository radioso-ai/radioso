# Quickstart: Verify Edition Organization Boundaries

## OSS bootstrap

1. Start an OSS stack against an empty database.
2. Confirm `GET /api/v1/auth/registration` returns `available: true`.
3. Register the first user and verify one organization, owner membership, and default workspace exist.
4. Confirm registration availability becomes false and a second direct registration returns `403` without new records.

## OSS collaboration and workspaces

1. Invite another email address from the bootstrap organization.
2. Accept the invitation and verify the new user joins the same organization.
3. As an authorized member, create an additional workspace and verify it succeeds.
4. Confirm the dashboard has no “New organization” action but still has “Create workspace”.

## Concurrency and rollback

1. Against an empty OSS database, issue two registration requests concurrently.
2. Verify one returns `201`, one returns `403`, and exactly one organization exists.
3. Force a failure after the account insert but before the core transaction completes and verify account, user, membership, and workspace records all roll back.
4. Force an orderly post-core hook failure and verify the complete graph is removed by compensation.
5. Verify the next registration attempt can bootstrap the server again.

## Enterprise

1. Start with the Enterprise module enabled.
2. Confirm registration remains available when organizations exist.
3. Create an additional organization and verify the session switches to it.
4. Verify the existing per-user monthly cap and unlimited override behavior.
5. Force account persistence and later provisioning failures and verify reserved capacity is released.

## Validation commands

```bash
cd backend
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
pnpm run build

cd ../frontend
pnpm test
pnpm run test:e2e -- organization-availability.spec.ts
pnpm run lint
pnpm run build

cd ..
pnpm --dir ee test
pnpm --dir ee build
pnpm run ci:local -- origin/main
```

## Validation evidence

Validated on 2026-07-20:

- Backend architecture boundaries, build, schema snapshot, generated database types, API contracts, prompts, and generated skill contracts passed.
- Backend unit: 345 files and 2,681 tests passed.
- Backend real-PostgreSQL integration: 111 files and 599 tests passed, including OSS bootstrap concurrency and lock release/retry.
- Backend contract: 44 files and 295 tests passed.
- Frontend lint and production build passed; unit: 93 files and 627 tests passed; Playwright: 95 passed and 5 Enterprise-only tests skipped.
- Documentation portal lint/build, TypeScript SDK build/tests, MCP build/tests/HTTP+Redis smokes, crawler build/tests, and Enterprise build/tests passed.
- Repository-wide `pnpm run ci:local -- --all` passed. The first attempt encountered an unrelated transient `socket hang up` in one chat integration test; the isolated file then passed 44/44 and the complete retry passed cleanly.

Transactional remediation focused validation on 2026-07-20:

- Backend typecheck, dependency boundaries, raw-SQL allowlist, and architecture validation passed.
- Backend focused auth, policy, API, and composition suites passed: 6 files and 105 tests.
- Real-PostgreSQL atomicity and concurrent OSS bootstrap suites passed: 2 files and 10 tests, including pool size one, full `AuthService` concurrency, post-insert rollback, and orderly post-core compensation.
- Frontend registration recovery and workspace-preservation Playwright suite passed: 4 tests.
- Enterprise build passed; Enterprise tests passed with 73 executed tests and 24 environment-dependent tests skipped.

Repository-wide remediation validation on 2026-07-20:

- `pnpm run ci:local -- --all` passed cleanly.
- Backend: build, schema/types snapshots, 345 unit files with 2,680 tests, 112 real-PostgreSQL integration files with 606 tests, and 44 contract files with 295 tests passed.
- Frontend: lint/build, 93 unit files with 627 tests, and 96 Playwright tests passed; 5 Enterprise-console tests were skipped in the OSS run.
- Docs portal, TypeScript SDK, MCP build/tests/HTTP+Redis smokes, crawler, and Enterprise build/tests all passed.
- Senior review pass 2 identified one reservation-lifecycle issue; moving password hashing before reservation fixed it, backend typecheck and 73 affected auth tests passed, and senior review pass 3 was clean.
- The single engineering-manager scope/release review approved the feature with no in-scope release blockers.
- The exact `pnpm run ci:local -- origin/main` branch-diff command selected all buckets. Three runs each encountered a different unrelated intermittent test (`usage-trends.spec.ts` layout readiness, `assistant.contract.test.ts` socket hangup, and a conversation handback race); each failed file passed immediately in isolation (1/1, 4/4, and 3/3 respectively). The equivalent broad all-buckets run above passed cleanly, and every feature-focused suite remained green.
