# FIX P1-1 Notes: DB-Backed Routines in Chat Turns

## Seam Change

`ChatRoutineProvider` is now an async, agent-aware per-turn seam:

- `forTurn({ modelGateway, agentId })` loads the routines applicable to the prepared turn's agent.
- It returns `{ activator, runner }` when at least one routine is available.
- It returns `null` when no static or published routine applies, so `ChatService` does not load routine state for that turn.

`ChatService` still does not construct engine routine internals. It builds the per-turn model gateway, passes the turn agent id to the provider, and only creates the deferred routine state store after the provider returns non-null routine ports.

## Per-Turn Loading Flow

`buildChatServices` now wires `createPublishedRoutineRegistrationSource(routineDefinitionRepository)` into the chat routine provider. For each turn:

1. Load published routine definitions with `listPublishedByAgent(agentId)`.
2. Compile the published definitions into `RoutineRegistration[]`.
3. Union static composition registrations with the published registrations.
4. Build a `RoutineRegistry`, activator, and `DefaultRoutineRunner` over the union.
5. Return `null` if the union is empty.

Malformed published definitions are logged and skipped. Repository load failures are logged and the turn continues with static registrations only. The engine remains pure; loading, compiling, and unioning live in backend composition.

The new per-turn DB query is intentional for correctness. A cheap "has published routines" gate or cache can be added later, but this slice does not build it.

## Acceptance Test

Added `tests/integration/chat.integration.test.ts`: "activates and runs a published routine definition during a chat turn".

The test:

- Publishes a routine definition for the resolved default agent through `RoutineDefinitionService`.
- Sends `/api/v1/assistant/chat` with a matching user turn.
- Uses a deterministic chat gateway to approve activation and render the routine step reply.
- Asserts the HTTP response and persisted assistant message come from the published routine.

This test exercises the chat turn path through the existing test app harness with an in-memory published routine repository and routine state store.

## Results

- `pnpm --dir backend exec tsc -p tsconfig.json --noEmit`: passed.
- `pnpm --dir backend run lint:boundaries`: passed.
- Focused non-HTTP seam tests: `pnpm --dir backend exec vitest run tests/unit/routine-definition-composition.test.ts tests/unit/chat-service-streaming.test.ts tests/unit/routine-definition-service.test.ts tests/unit/contact-routine-module.test.ts`: passed, 4 files / 65 tests.
- Targeted acceptance test command: `pnpm --dir backend exec vitest run tests/integration/chat.integration.test.ts -t "published routine"` was blocked by the sandbox with `listen EPERM: operation not permitted 0.0.0.0` from Supertest.
- Requested full Vitest command: `pnpm --dir backend exec vitest run tests/unit tests/contract` was blocked by the same sandbox listener restriction across HTTP/Supertest tests and exited with 272 reported failures.
- Requested build command: `pnpm --dir backend run build` was blocked during `generate:openapi` because `tsx` could not create its IPC listener: `listen EPERM: operation not permitted /tmp/claude-501/tsx-501/...pipe`.

Contact routine parity: `tests/unit/contact-routine-module.test.ts` passed in the focused run, and static routine registrations are still unioned before DB-backed published routines so existing activation order is preserved.

## Independent verification (orchestrator, 2026-06-09)
- The acceptance test (`tests/integration/chat.integration.test.ts` "activates and runs a published routine definition during a chat turn") is a genuine guard: it `createDraft`+`publish` via `routineDefinitionService` (a real DB-published routine), drives `POST /api/v1/assistant/chat`, and asserts the answer + persisted assistant message are the routine's distinctive reply and that activation was consulted. On the old static-only wiring the published routine never loads, so it fails pre-fix by construction.
- Verified myself (Codex's sandbox can't bind Supertest): **full `vitest run tests/unit tests/contract` + the acceptance test → 1886 pass (0 fail)**; `tsc` clean; `lint:boundaries` clean (557 modules). Contact-flow (static routine) parity holds.
- Seam: `ChatRoutineProvider.forTurn({ modelGateway, agentId })` is async + agent-aware; per turn it loads the agent's published routines, compiles + unions with static registrations, returns null when empty (turns unchanged); malformed published defs are logged + skipped, never crash the turn.
