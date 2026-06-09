# Routine Authoring API Notes

## Independent verification (orchestrator, 2026-06-09)

Codex's sandbox blocked socket binding (`listen EPERM`), so it could not run the contract tests (supertest) or `test:contract`. Re-verified in the installed workspace:

- **Contract + service tests**: `agents.contract.test.ts` + `routine-definition-service.test.ts` → **26/26 pass** (incl. the route tests Codex couldn't run).
- **Publish-rejects-invalid (key behavior)**: confirmed in all three layers — `service.publish` returns `{rejected, validation}` on `!validation.ok`; the route maps it to **HTTP 422**; the contract test asserts 422 on an invalid draft. Happy path: create→list→get→update→validate→publish → `status: "published"` with a new version id. Unauthenticated access rejected.
- **OpenAPI**: `check-api-contracts.mjs` → "artifacts are current" (backend `openapi.yaml/json` + SDK + MCP generated types regenerated consistently, not hand-edited).
- **Typecheck**: `tsc --noEmit` clean. **Boundaries**: `lint:boundaries` clean (554 modules).
- **Code review**: routes are transport-only (parse → delegate → `next(error)`), `agentRead`/`agentManage` auth mirrors the directive routes, the service depends on a `RoutineDefinitionRepositoryPort` (interface) and scopes every call to the workspace via `requireAgent` — no SQL in the service.

Carried-forward follow-ups (still open from Slice 1): wrap repo multi-statement writes in a transaction; move the inline activation prompt to `backend/prompts/`; renumber migration `080`→`083+` on rebase. Not exercised here: the SQL repo against a real Postgres (integration-level; defer to `ci:local`).

## Files Added Or Changed

- Added `backend/src/modules/routines/service.ts` and exported `RoutineDefinitionService` from `backend/src/modules/routines/public.ts`.
- Extended `backend/src/db/repositories/routineDefinitionRepository.ts` with all-status listing and draft deletion for the authoring API.
- Added routine routes to `backend/src/app/http/routes/agentRoutes.ts`.
- Wired `routineDefinitionService` through `backend/src/app/server/types.ts`, `backend/src/app/server/dependencies.ts`, `backend/src/app/server/dependencyBuilders.ts`, and the test harness in `backend/tests/support/testApp.ts`.
- Added an in-memory routine definition repository to `backend/tests/support/fakes.ts`.
- Added route contract coverage in `backend/tests/contract/agents.contract.test.ts`.
- Added service unit coverage in `backend/tests/unit/routine-definition-service.test.ts`.
- Updated code-first OpenAPI registration in `backend/src/app/http/openapi/openApiRegistry.ts`, `backend/src/app/http/openapi/schemas/agentSchemas.ts`, and `backend/src/app/http/openapi/paths/agentsPaths.ts`.
- Regenerated `backend/openapi.yaml` and `backend/openapi.json`.
- Synced generated contract artifacts required by `scripts/check-api-contracts.mjs`: `typescript-sdk/openapi/radioso.json`, `typescript-sdk/openapi/radioso.yaml`, `typescript-sdk/src/generated/types.ts`, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts`. These are generated from the backend OpenAPI change; no SDK or MCP behavior was implemented.

## Draft Validation Policy

Create and update parse the request body with `routineDefinitionDraftInputSchema`, then save the draft and return `validateRoutineDefinition` diagnostics as advisory output. Draft saves do not hard-block on graph diagnostics because authors need to save incomplete work while still seeing author-facing diagnostics.

Publish is stricter: it runs `validateRoutineDefinition`, rejects invalid drafts with a structured `422` response containing diagnostics, then runs `compileRoutineDefinition` as a smoke check before persisting the published snapshot.

No new observability was added for this slice. The API is control-plane CRUD/validation only, introduces no worker handoff, provider call, retry/fallback path, or runtime conversation behavior, and returns author-facing diagnostics synchronously.

## Routes

- `GET /api/v1/agents/:agentId/routines`
- `GET /api/v1/agents/:agentId/routines/:routineId`
- `POST /api/v1/agents/:agentId/routines`
- `PATCH /api/v1/agents/:agentId/routines/:routineId`
- `POST /api/v1/agents/:agentId/routines/:routineId/validate`
- `POST /api/v1/agents/:agentId/routines/:routineId/publish`
- `DELETE /api/v1/agents/:agentId/routines/:routineId` for drafts, mirroring the directive delete precedent.

All routes use the existing workspace session and `workspace.agents.read` / `workspace.agents.manage` authorization pattern from directive routes.

## OpenAPI

Code-first schemas and paths were added under the existing Agents OpenAPI registry. `backend/openapi.yaml` and `backend/openapi.json` were regenerated.

The normal command failed in this sandbox:

```text
pnpm --dir backend run generate:openapi
Error: listen EPERM: operation not permitted /tmp/claude-501/tsx-501/57923.pipe
```

To avoid hand-editing the generated files, I compiled the backend TypeScript to `/private/tmp/radioso-backend-openapi-build` and invoked the generated JS OpenAPI document builder to write `backend/openapi.yaml` and `backend/openapi.json`.

After that, I ran the owning generated contract sync commands:

```text
pnpm --dir typescript-sdk run sync
pnpm --dir packages/radioso-mcp-server run sync:openapi
```

## Verification

Passed:

```text
pnpm --dir backend exec vitest run tests/unit/routine-definition-service.test.ts
Test Files  1 passed (1)
Tests  3 passed (3)
```

```text
pnpm --dir backend exec tsc --noEmit -p tsconfig.json
```

No output; exit code 0.

```text
pnpm --dir backend run lint:boundaries
✔ no dependency violations found (554 modules, 1250 dependencies cruised)
```

```text
node scripts/check-api-contracts.mjs
API contract artifacts are current.
```

Blocked by sandbox listener restrictions:

```text
pnpm --dir backend exec vitest run tests/contract/agents.contract.test.ts -t "routine"
tests/contract/agents.contract.test.ts (23 tests | 3 failed | 20 skipped)
TypeError: Cannot read properties of null (reading 'port')
Error: listen EPERM: operation not permitted 0.0.0.0
```

Blocked by sandbox `tsx` IPC restrictions:

```text
pnpm --dir backend run test:contract
build:conversation-defaults: passed
build:conversation-engine: passed
build:mcp: passed
generate:openapi: failed
Error: listen EPERM: operation not permitted /tmp/claude-501/tsx-501/92002.pipe
```

No engine, UI, SDK, MCP, contact transplant, fast-forward, typed-slot runtime, condition-gated action runtime, or versioning runtime changes were implemented in this slice.
