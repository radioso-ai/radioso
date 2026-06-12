# Slice 2 Notes: Routine Schema Cuts

**Date**: 2026-06-11
**Branch**: `routine-text-composer`
**Scope**: `amendment-authoring-surface.md` §12 item 2 only.

## Delivered

- Removed authored step kind `fork` from the routine definition domain schema and generated OpenAPI/SDK/MCP contract types.
- Unified authored transition guard kinds `always` and `fallback` into one stored representation: `guardKind: "default"`.
- Updated the compiler to emit `RoutineGuard { kind: "default" }` for default edges.
- Updated the pure routine runner so a default edge is immediate only when it has no conditioned siblings, and otherwise acts as the last resort after deterministic and LLM edges do not match.
- Pinned counter exhaustion with a runtime golden test: a `counter` guard allows the bounded retry while under the limit; once exhausted, the default edge is forced.
- Added migration `089_routine_default_guard_schema_cut.sql` to convert existing `routine_step.kind='fork'` rows to `chat`, convert `routine_transition.guard_kind IN ('always', 'fallback')` to `default`, and replace the relevant check constraints.
- Preserved local-startup parity by normalizing legacy persisted `fork`, `always`, and `fallback` values on repository reads.
- Updated the routine document module and fixture parser/serializer to round-trip `default`, while accepting legacy fixture aliases `[always]` and `[fallback]`.
- Updated current docs/spec artifacts that enumerate routine step or guard kinds.
- EM verification found a blocking frontend gap after the backend/contracts cut: the transitional slice-5 form still authored `fork`, `always`, and `fallback`. Fixed the frontend routine API types, form adapter, guard picker, unit tests, and e2e spec literals so new drafts emit `guardKind: "default"` and older payloads still read by normalizing `fork -> chat` and `always`/`fallback -> default`.

## Representation Decision

The surviving unconditioned-edge representation is `default` in authoring data and `{ kind: "default" }` in the compiled runtime graph. The runtime derives behavior from sibling context: a sole default edge is taken immediately, while a default edge alongside conditioned siblings is the final edge after structured and LLM choices fail. This removes the stored distinction between `always` and `fallback` without changing observable behavior.

## Counter Guard Orientation Change (breaking, deliberate)

This slice **inverts the runtime orientation of the `counter` guard** — it is a behavior change, not a rename, recorded here explicitly (EM verification finding):

- **Before**: a counter edge *fired at exhaustion* (`attempts >= limit`); authors pointed the counter edge at the exhaustion target (e.g. handoff), and the prior engine test ("routes to a handoff terminal through a counter guard on the second failed attempt") encoded that.
- **After**: a counter edge is the *bounded loop/retry edge* (`attempts < limit`); exhaustion makes it stop matching, forcing the sibling default edge — per amendment §8.2 ("counter chip on a loop/retry row → bound; exits to the default edge when exhausted") and the §8.4 worked example.

The amendment's orientation is the one the document surface means by a counter chip, so the runtime was aligned to it and the old engine test was rewritten (not preserved). Blast-radius check at the time of change: the built-in contact routine uses no counter guards, and no seeded/built-in definition carries one; 082 authoring shipped 2026-06-09, so pre-existing operator-authored counter routines are unlikely but were **not** migrated — migration 089 converts `always`/`fallback` rows only and does not reorient counter transitions. Any old-orientation authored counter edge would, after this change, loop instead of exiting at the limit. If such definitions are found in a live environment, they need manual re-authoring (swap the counter edge to the loop target and let the default edge carry the exit).

## Boundary Review

- The engine remains independent of authoring modules. The contract change is in `packages/conversation-contract/index.d.ts`; runtime behavior is in `packages/conversation-engine/src/routineRunner.ts`.
- The backend authoring schema remains in `backend/src/modules/routines/domain.ts`; compiler, validator, repository, document transform, and fixture modules consume that schema.
- The OpenAPI source of truth in this branch is `backend/src/app/http/openapi/schemas/agentSchemas.ts` plus the imported Zod routine schema, not the older `backend/src/app/http/openapi/document.ts` path named in the prompt.
- No `backend/src/app/composition/` update was needed. This slice changes data representation and pure runtime selection semantics, not app-wide wiring.

## Message-Queue Impact Review

No AMQP or document-worker queue contract changes are needed. The changed values are routine definition step/guard enums and compiled in-memory routine graph guards. Searches found no document worker dispatch payload, AMQP payload, retry semantics, or queue docs carrying routine step kinds or routine guard kinds. Existing routine action outbox payloads carry action requests, not these authoring enums.

## Observability Review

No observability was added. This slice introduces no provider call, worker job, queue handoff, new operator latency path, retry sink, or support-correlation path. It changes schema representation and pure in-process routine edge selection. Existing errors and traces continue to use routine/step ids and terminal metadata without logging prompts, completions, slots, or document content.

## Validation Evidence

Red phase before implementation:

```bash
cd backend && pnpm vitest run tests/unit/routine-definition-service.test.ts tests/unit/routine-document-roundtrip.test.ts
```

Result: failed as expected. `default` was rejected by the old Zod guard enum, document projection still returned `always`/`fallback`, and compiler output omitted the default runtime guard.

```bash
cd packages/conversation-engine && pnpm vitest run tests/defaultRoutineRunner.test.ts
```

Result: failed as expected. The new counter-exhausted default-edge test failed because the runner did not recognize `{ kind: "default" }`.

Focused green checks:

```bash
cd backend && pnpm vitest run tests/unit/routine-definition-service.test.ts tests/unit/routine-document-roundtrip.test.ts tests/unit/routine-definition-domain.test.ts
```

Result:

```text
Test Files  3 passed (3)
Tests       37 passed (37)
```

Post-review migration-ordering fix rerun:

```bash
cd backend && pnpm vitest run tests/unit/routine-definition-service.test.ts tests/unit/routine-document-roundtrip.test.ts tests/unit/routine-definition-domain.test.ts tests/unit/run-migrations.test.ts
```

Result:

```text
Test Files  4 passed (4)
Tests       43 passed (43)
```

```bash
cd packages/conversation-engine && pnpm vitest run tests/defaultRoutineRunner.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       28 passed (28)
```

```bash
cd backend && pnpm vitest run tests/unit/contact-routine-module.test.ts tests/unit/contact-routine-ranked-activation.test.ts tests/unit/contact-routine.test.ts tests/unit/deferred-routine-store.test.ts tests/unit/routine-chat-model-gateway.test.ts tests/unit/routine-definition-composition.test.ts tests/unit/routine-definition-domain.test.ts tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-service.test.ts tests/unit/routine-document-roundtrip.test.ts tests/unit/routine-next-step-selector.test.ts tests/unit/routine-registry.test.ts tests/unit/routine-state-repository.test.ts tests/unit/routine-step-renderer.test.ts tests/unit/run-migrations.test.ts
```

Result:

```text
Test Files  15 passed (15)
Tests       84 passed (84)
```

Contract generation:

```bash
cd backend && pnpm run generate:openapi
```

Result: failed in this sandbox before generation because the `tsx` CLI tried to open `/tmp/claude-501/tsx-501/*.pipe` and hit `listen EPERM`.

Workaround used:

```bash
cd backend && node --import tsx ./scripts/generateOpenApi.ts
cd typescript-sdk && pnpm run sync
cd packages/radioso-mcp-server && pnpm run sync:openapi
node scripts/check-api-contracts.mjs
```

Result: OpenAPI, SDK, and MCP generated artifacts updated; `scripts/check-api-contracts.mjs` reported `API contract artifacts are current.`

Required broad backend unit command:

```bash
cd backend && pnpm run test:unit
```

Result: package prebuilds completed, then Vitest ran. It did not pass in this sandbox because Supertest-based suites cannot bind sockets:

```text
Test Files  13 failed | 227 passed (240)
Tests       77 failed | 1642 passed (1719)
Errors      72 errors
```

Representative failures:

```text
Error: listen EPERM: operation not permitted 0.0.0.0
TypeError: Cannot read properties of null (reading 'port')
```

Affected files included route/webhook/HTTP tests such as `websiteCrawler/routes.test.ts`, `frontend-product-analytics-routes.test.ts`, `quality-routes.test.ts`, `connectors/whatsapp/whatsappWebhook.test.ts`, `connectors/wordpress/wordpressWebhookRouter.test.ts`, `security-headers.test.ts`, and `opentelemetry-http.test.ts`.

Relevant contract suite:

```bash
cd backend && pnpm vitest run tests/contract/agents.contract.test.ts
```

Result: all 25 tests failed before assertions for the same Supertest socket bind restriction (`listen EPERM 0.0.0.0` / null port). The routine authoring contract scenarios in that file could not execute in this sandbox.

Frontend EM-gap fix validation:

```bash
cd frontend && pnpm test
```

Result:

```text
Test Files  63 passed (63)
Tests       355 passed (355)
```

```bash
cd frontend && pnpm run lint
```

Result: passed (`eslint .` completed without findings).

Frontend Playwright note: `frontend/tests/e2e/routines-settings.spec.ts` was updated from `always` to `default`, but Playwright was not run in this sandbox because browser/e2e execution cannot bind or launch reliably here. The changed assertion is covered by the unit-level draft serialization path and should be exercised in a browser-capable environment.

## Commit Status

No commit, push, or PR was created per EM instruction.

## Review Evidence

Senior engineer review pass:

- Found stale planning references to `backend/src/app/http/openapi/document.ts`. Fixed the plan/tasks to name the actual branch-local OpenAPI source: `backend/src/app/http/openapi/schemas/agentSchemas.ts` importing the routine Zod schema.
- Found migration ordering risk: converting `routine_transition.guard_kind` to `default` before dropping the old check constraint would fail on databases with the old `always`/`fallback` constraint. Fixed migration `089` to drop guard-kind check constraints first, then convert data, then add the new check.
- Re-ran focused backend routine/migration tests and the pure engine runner test after fixes; both passed.

Engineering manager pass:

- Scope fit: limited to §12 item 2. No UI, prompt, export/import, AMQP, or unrelated runtime work was added.
- Release risk: main residual risk is contract/route suites could not execute in this sandbox because Supertest cannot bind sockets. Generated contract artifacts were checked directly, and routine unit/engine/migration coverage passed.
- Recommendation: ready for EM verification in a socket-capable environment; leave uncommitted as requested.
