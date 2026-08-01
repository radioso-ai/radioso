# Fifth-pass review: 103 Turn Skill Slot Filling

## APPROVE

1. **D9 / FR-018 deterministic scalar normalization — Closed.** The table defines accepted model representations, canonical values, and rejection rules for every supported scalar. String-only permitted values, trimmed case-insensitive matching, and prompt-provided clock/time-zone context for relative dates remove the prior unresolved choices. The precise normalizer API and decimal-parser mechanics are normal planning-phase detail.

2. **FR-019 default — Closed.** The default is explicitly 20 most-recent messages and 8,000 total characters, dropping oldest first, with both limits configurable.

3. **D6 normalizer ownership — Closed.** The package manifests confirm `@radioso/conversation-defaults` depends on `@radioso/conversation-engine`, while `@radioso/conversation-engine` depends on `@radioso/conversation-contract` and not on defaults. Moving a defaults-owned normalizer into engine consumption would therefore create a dependency cycle. Keeping the pure resolver normalizer in defaults for this one-consumer slice, while leaving the routine-specific engine verifier untouched, is correct.

4. **D8 / US2 scenario 4 honesty — Closed.** The draft now distinguishes reliable re-selection for an `always` directive from non-guaranteed re-matching for contextual directives, and separately states that a routine claim skips normal selection. US2 scenario 4 is limited to the `always` case and names the host-forced alternative where a guarantee is required.

## New issues

None material. The remaining implementation choices are normal planning-phase detail, not spec-level gaps.
