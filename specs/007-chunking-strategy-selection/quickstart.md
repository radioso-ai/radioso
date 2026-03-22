# Quickstart: Selectable Chunking Strategies

## 1. Prepare

1. Work on branch `codex/007-chunking-strategy-selection`.
2. Review the approved spec, plan, research, contract, and data-model artifacts in `/tmp/radioso-chunking-strategy-selection/specs/007-chunking-strategy-selection/`.
3. Confirm backend work will follow TDD before implementation begins.

## 2. Implement Backend First

1. Add failing backend tests for retrieval-settings validation and persistence of `chunkingStrategy`.
2. Add failing backend tests for strategy resolution during document ingest:
   - default strategy is fixed-window
   - selected strategy is loaded from account settings
   - unsupported strategy values are rejected safely
3. Add failing backend unit tests for structured chunking behavior:
   - deterministic parsing of headings, paragraphs, lists, tables, code fences, and FAQ pairs
   - bounded splitting of oversize structural units
   - topic-based merge and split behavior for adjacent blocks
   - structure-only fallback when semantic similarity is unavailable
4. Add failing backend contract and integration tests for the updated settings payload and ingest behavior.
5. Implement the settings, migration, chunking strategy seam, structured strategy, and ingest wiring until backend tests pass.

## 3. Implement Frontend

1. Update settings API types for `chunkingStrategy`.
2. Add a chunking strategy selector and explanatory copy to the Settings screen.
3. Preserve the existing save flow and show that strategy changes apply on future ingests or updates.
4. Do not add advanced structured-chunking tuning controls in this feature.

## 4. Verify

1. Load Settings and confirm the current strategy is shown.
2. Save `structured_semantic`, reload the page, and confirm the same value is returned.
3. Ingest a structured document and verify chunk outputs follow structural boundaries and size bounds.
4. Temporarily simulate missing semantic similarity and confirm structure-only fallback still produces bounded chunks.
5. Change the strategy after an existing document is ingested and confirm stored chunks remain unchanged until that document is updated or re-ingested.
6. Save `fixed_window` again and confirm rollback to the existing strategy remains available.

## 5. Finish

1. Update contract documentation and any relevant examples.
2. Run the relevant backend test suites plus frontend verification for the selector.
3. Proceed to task breakdown only after the design artifacts still match the approved spec.
