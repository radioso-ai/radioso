# Quickstart: Triggered Retrieval Filters

## Prerequisites

- Backend and frontend dependencies installed.
- Test database available through the normal Radioso test setup.
- Authenticated workspace session available for manual dashboard verification if running UI checks.

## Validation Scenarios

### 1. No triggerable rules skip matcher execution

1. Load retrieval settings for a workspace with no rules containing trigger instructions.
2. Run a retrieval-backed chat turn.
3. Verify retrieval diagnostics and trace show trigger analysis as skipped because no triggerable rules were configured.
4. Verify no extra trigger-match model execution was required.

### 2. Single trigger match activates only the intended rule

1. Save a retrieval rule with:
   - effect `boost` or `filter`
   - a trigger instruction for upcoming events or time-bound content
2. Ask a matched question such as “When is the next conference?”
3. Verify diagnostics show the rule as considered and matched with a bounded reason.
4. Verify the rule is enacted in candidate preparation and reflected in applied constraints.

### 3. Broad factual question avoids a false-positive trigger

1. Reuse the same workspace and triggerable rule.
2. Ask a broad factual question such as “What is mononuclear disease?”
3. Verify the trigger decision records a non-match and no trigger-based rule is enacted.
4. Verify baseline retrieval remains available.

### 4. Multi-match handling records more than one active trigger

1. Configure two different triggerable rules with overlapping but distinct intents.
2. Ask a query that legitimately matches both.
3. Verify diagnostics record both matched rule ids and do not collapse them into one label.
4. Verify candidate preparation enacts both matched rules.

### 5. `today()` stays dynamic across execution dates

1. Save a date-based rule using `today()` with a supported date comparison.
2. Run metadata-rule evaluation under two different effective dates in automated tests.
3. Verify the rule resolves relative to the execution date instead of a saved literal string.

### 6. Invalid dynamic date usage fails safely

1. Attempt to save or validate a rule that uses `today()` in an unsupported non-date context.
2. Verify validation fails with a clear message.
3. Verify malformed persisted input degrades safely during execution and does not force a narrow filter.

### 7. Trigger-enacted hard filtering can back off

1. Configure a triggerable rule with `effect = filter`.
2. Run a matched query where the filter yields empty or weak support.
3. Verify candidate preparation relaxes the trigger-enacted narrowing.
4. Verify diagnostics, trace, and replay artifacts record the backoff decision and relaxed rule ids.

### 8. Settings UI saves and reloads trigger-aware rules

1. In the dashboard retrieval settings panel, create:
   - one always-on rule
   - one trigger-based rule
   - one date rule using `today()`
2. Save and reload the page.
3. Verify the UI preserves trigger mode, trigger instruction, readable policy labels, and the dynamic date value.

### 9. History preserves trigger diagnostics

1. Run a chat turn with at least one triggerable rule configured.
2. Open chat history diagnostics and confirm the dedicated trigger-analysis node is visible.
3. Open retrieval trace details and verify trigger decisions appear in diagnostics.
