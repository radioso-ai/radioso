# Quickstart: Eval Regression Lab

## Scenario 1: Create a dataset and add a manual retrieval-focused case

1. Open the dashboard eval surface.
2. Create a new dataset for a concrete quality goal such as retrieval regressions or public-chat regressions.
3. Add a manual case with a query and any required prior context.
4. Configure retrieval-focused expectations such as expected documents, expected citations, refusal behavior, or answer-support outcome.
5. Save the case.
6. Confirm the dataset shows the new runnable case without requiring exact-answer text.

## Scenario 2: Add an existing authenticated conversation turn to a dataset

1. Open `History` and select a saved authenticated conversation with retrieval diagnostics.
2. Choose an assistant turn that should become a regression guard.
3. Start the “Add to eval dataset” flow.
4. Review the imported query, preserved context window, and seeded expectations.
5. Redact or trim any content that should not be stored durably.
6. Save the case into an existing or new dataset.
7. Confirm the saved case preserves the selected context and expectations.

## Scenario 3: Add an existing anonymous/public conversation turn to a dataset

1. Open a saved anonymous/public conversation that the operator is authorized to inspect.
2. Start the same “Add to eval dataset” flow from a selected turn.
3. Review the imported draft and any seeded expectations.
4. Confirm the case provenance indicates a public or anonymous source.
5. Save the case.
6. Confirm the resulting eval case replays through the same shared eval model as authenticated imports.

## Scenario 4: Run a dataset against the current workspace behavior

1. Open a dataset with one or more saved cases.
2. Start a new eval run.
3. Wait for replay to complete.
4. Inspect the aggregate summary.
5. Confirm each case reports pass/fail or skipped status and dimension-level results.
6. Confirm bounded replay diagnostics are available for failed or suspicious cases.

## Scenario 5: Compare a new run against a baseline

1. Run a dataset once to establish a baseline.
2. Change retrieval settings or switch to a different implementation revision.
3. Run the same dataset again.
4. Open the comparison view.
5. Confirm the comparison reports regressions, improvements, and unchanged cases.
6. Confirm at least one regressed case shows a concrete reason such as citation loss, document mismatch, refusal mismatch, answer-policy change, or earlier retrieval-stage degradation.

## Scenario 6: Import a historical turn with missing diagnostics

1. Select a historical conversation turn that predates full retrieval-trace capture or lacks answer-support metadata.
2. Start the import flow.
3. Confirm the draft still preserves the query and bounded context.
4. Confirm unavailable diagnostics are shown explicitly instead of blocking the import.
5. Save the case with manually chosen expectations where needed.

## Scenario 7: Use retrieval-only scoring to ignore harmless wording drift

1. Import or create a case whose quality depends on the correct supporting documents and citations, not the exact final wording.
2. Leave exact-answer checks disabled.
3. Run the dataset twice with small non-semantic wording differences between runs.
4. Confirm the case still passes when retrieval expectations hold.
5. Confirm the comparison view distinguishes wording drift from an actual retrieval regression.
