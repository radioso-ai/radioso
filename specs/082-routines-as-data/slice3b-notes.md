# Slice 3b Notes - Per-action Permission Gate

## Independent verification (orchestrator, 2026-06-09)

Codex could not run the full suite (sandbox `listen EPERM` on contract tests) — its "272 failures" were that restriction, not logic. Re-verified in the installed workspace:

- **Full backend suite**: `vitest run tests/unit tests/contract` → **1846 pass (0 fail)** (+5 permission tests). `tsc` clean. `lint:boundaries` clean (557 modules, +1 for `actionCapabilities`).
- **Publish gate**: `RoutineDefinitionService.publish` runs `validateActionAuthorization` after graph validation and returns `{ rejected, validation }` (author-facing) for an unregistered or over-permission action type — verified via a fake action-capability map + deny-set `CapabilityPolicy` in the service test.
- **Enqueue gate**: `chatTurnLifecycle.filterAuthorizedActions` drops denied actions before the outbox (both transactional + fallback paths), logging structured denial metadata without payloads.
- **Parity**: reuses `CapabilityPolicy`, defaulting to `DefaultAllowCapabilityPolicy` when none is injected, so an authorized `contact.send` publishes + enqueues unchanged. No OpenAPI/public-schema change (no SDK/MCP sync needed).

## Capability Map Wiring

- `ApplicationActionHandlerRegistration` now accepts `requiredCapabilities?: string[]`.
- Composition builds one `StaticActionCapabilityMap` from the registered action handlers and exposes it on `ApplicationComposition.actionCapabilityMap`.
- The built-in `contact.send` action declares `human_contact.request` via `capabilityNames.humanContact.request`.
- `RoutineDefinitionService` receives the composition action capability map plus the existing `CapabilityPolicy`.
- `ChatService` passes the same action capability map plus `CapabilityPolicy` into `ChatTurnLifecycle`.

## Enforcement Points

- Publish-time: after structural validation passes, `RoutineDefinitionService.publish` checks every `action` terminal.
  - Unregistered action types reject publish with `unregistered_action_type`.
  - Missing required capabilities reject publish with `action_capability_denied`.
  - Diagnostics name the terminal, action type, and missing capability.
- Enqueue-time: `ChatTurnLifecycle` filters emitted routine actions before both the transactional persistence path and fallback outbox path.
  - Unregistered or capability-denied actions are skipped.
  - Other actions in the same turn still enqueue.
  - Denials are recorded through a structured warning log containing workspace id, conversation id, action type, reason, and capability when applicable. Raw payloads are not logged.

## Verification

- Focused TDD run:
  - `pnpm --dir backend exec vitest run tests/unit/routine-definition-service.test.ts tests/unit/chat-turn-lifecycle.test.ts` - passed, 12 tests.
- Nearby parity/composition run:
  - `pnpm --dir backend exec vitest run tests/unit/contact-routine.test.ts tests/unit/contact-routine-module.test.ts tests/unit/chat-service-streaming.test.ts` - passed, 60 tests.
  - `pnpm --dir backend exec vitest run tests/unit/routine-definition-service.test.ts tests/unit/chat-turn-lifecycle.test.ts tests/unit/contact-routine-module.test.ts tests/unit/default-composition.test.ts` - passed, 33 tests.
- Requested full Vitest run:
  - `pnpm --dir backend exec vitest run tests/unit tests/contract` - failed in this sandbox: 34 failed files, 272 failed tests, 217 passed files, 1574 passed tests.
  - The common failure was Supertest/server binding in the sandbox: `listen EPERM: operation not permitted 0.0.0.0`, followed by `Cannot read properties of null (reading 'port')` across contract and route tests.
- TypeScript:
  - `pnpm --dir backend exec tsc -p tsconfig.json --noEmit` - passed.
- Boundaries:
  - `pnpm --dir backend run lint:boundaries` - passed.

No public OpenAPI schema changed, so OpenAPI/SDK/MCP sync was not run.
