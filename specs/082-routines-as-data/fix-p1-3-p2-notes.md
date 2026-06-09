# Fix P1-3 + P2 Notes

## P1-3 Runtime Action Denial

- Runtime action authorization now fails the assistant turn when any emitted routine action is denied.
- The denial is logged with workspace, conversation, action type, reason, and capability only; the action payload is not logged.
- The failure happens before success persistence, outbox enqueue, routine state transition, success audit, or fallback message creation.
- The existing chat service catch path records the turn failure and prevents streaming the routine confirmation chunk.
- Authorized actions still pass through unchanged.

## P2 Routine Validation Code Contract

- `routineValidationCodes` is now the runtime source of truth for `RoutineValidationCode`.
- OpenAPI `RoutineValidationResult.diagnostics[].code` consumes that source directly.
- Backend OpenAPI, TypeScript SDK OpenAPI/types, and MCP OpenAPI types were regenerated from the complete enum.
- A contract test compares the OpenAPI enum exactly against `routineValidationCodes` to prevent future drift.


## Independent verification (orchestrator, 2026-06-09)
- **P1-3:** a runtime-denied routine action now **throws** `RoutineActionAuthorizationError` from the action-authorization check **before** any persistence; the denial test asserts `completeAssistantTurn` rejects and that the success message, message write, outbox enqueue, routine-state commit, and audit are all NOT called (no false "sent"). ChatService wraps the lifecycle call in try/catch → `recordFailure`, so the throw routes to the existing turn-failure/fallback path (graceful, not an unhandled 500). Denial logged (structured, no payload). Authorized actions complete unchanged (parity test).
- **P2:** `routineValidationCodes` is a single exported `const` consumed by both the validator type and the OpenAPI `z.enum`, so the enum can't drift; a contract guard test asserts the OpenAPI code set equals the union. SDK/MCP regenerated; `check-api-contracts` current.
- Verified myself (Codex sandbox can't bind Supertest): full `vitest run tests/unit tests/contract tests/integration/chat.integration.test.ts` → **1886 pass**; `tsc` clean; `lint:boundaries` clean; `check-api-contracts` current.
