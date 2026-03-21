# Quickstart: Retrieval Pipeline Stages

## Goal

Validate that the retrieval pipeline refactor preserves current behavior while improving modular seams.

## Recommended Validation Order

1. Run focused unit tests for the new stage modules and the updated retrieval orchestrator.
2. Run existing retrieval-related unit tests that cover edge cases, hybrid retrieval behavior, and chat retrieval domain behavior.
3. Run targeted integration tests for chat retrieval behavior if orchestrator wiring or dependency construction changes.

## Suggested Commands

```bash
pnpm --dir backend test -- --run backend/tests/unit/edge-cases.test.ts
pnpm --dir backend test -- --run backend/tests/unit/hybrid-retrieval-search.test.ts
pnpm --dir backend test -- --run backend/tests/unit/hybrid-retrieval-info.test.ts
pnpm --dir backend test -- --run backend/tests/unit/chat-retrieval.domain.test.ts
pnpm --dir backend test -- --run backend/tests/integration/chat.integration.test.ts
```

## Acceptance Checks

- Existing callers still construct and invoke the retrieval pipeline without API changes.
- Retrieval prompts, citations, and diagnostics remain structurally compatible with the chat layer.
- New stage tests demonstrate that major retrieval phases can be verified independently.
- `RetrievalPipelineService` is materially smaller and orchestration-focused after the refactor.
