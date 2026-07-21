# Quickstart: Verify Fused Turn Planning

## Focused verification

```bash
cd backend
pnpm exec vitest run \
  tests/unit/turn-plan-service.test.ts \
  tests/unit/turn-plan-coordinator.test.ts \
  tests/unit/chat-service-turn-planning.test.ts \
  tests/unit/workbench-replay-runner.test.ts
pnpm run build
```

```bash
cd packages/conversation-defaults
pnpm exec vitest run tests/routineRegistrySeams.test.ts
pnpm run build
```

## Live quality comparison

Run against a disposable workspace with Postgres, the document worker, and model
credentials available:

```bash
cd backend
CHAT_TURN_PLANNING_ENABLED=false pnpm run evals
CHAT_TURN_PLANNING_ENABLED=true pnpm run evals
```

Compare routing, routine activation, directives, response language, grounding,
answer quality, and model-call traces. Do not update the committed baseline
unless a behavior change is intentional and reviewed.

## Broader verification

```bash
pnpm run ci:local -- origin/main
```
