# FIX P1-2 — Action Steps, Not Action Terminals

## Summary

- `action` is now an authored routine step kind, alongside `chat`, `tool`, and `fork`.
- Terminals are now limited to `complete` and `handoff`.
- Authored action steps carry `actionType` and must have an outgoing transition to a real step or terminal.
- The runtime runner was not changed; it already supports runtime `RoutineStep.kind === "action"`.

## Backend

- Updated routine domain schemas and OpenAPI-derived contracts so `actionType` belongs to steps.
- Added migration `085_action_routine_steps.sql` to allow `routine_step.kind = 'action'`, add `routine_step.action_type`, and remove `action` from the terminal kind check.
- Updated repository mapping to persist and load step `action_type`; terminal persistence no longer writes `action_type`.
- Updated compiler so authored action steps compile to runtime action steps, while terminals compile only to runtime terminal steps.
- Updated validator to reject:
  - action steps without `actionType`
  - action steps without an outgoing transition to a real node
  - transitions whose source is not an authored step
- Updated publish-time action authorization to validate action steps instead of action terminals.
- Moved the built-in contact routine `send` node from `terminals` to `steps`; `send -> done` is preserved.

## Frontend

- Added `action` to the step kind selector and exposed a per-step action type input.
- Removed `action` from terminal kind options.
- Updated routine form serialization so action steps round-trip `kind`, `actionType`, and transitions.
- Transition ordinals now remain stable across all steps instead of resetting per step.

## Contracts

- Regenerated backend OpenAPI.
- Synced TypeScript SDK OpenAPI artifacts.
- Synced MCP OpenAPI types.

## Observability

No new runtime path, worker handoff, provider call, retry, or operator-relevant latency was introduced. This is an authoring-model and validation fix, so no new logs, metrics, audit events, or spans were added.
