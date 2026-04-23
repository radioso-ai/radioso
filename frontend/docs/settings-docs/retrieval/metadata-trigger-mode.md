# Trigger Mode

## Summary
Choose whether a metadata rule is always active or only activates for matching turns.

## Details
### Overview

Trigger mode changes when a rule is allowed to shape retrieval.

- **Always on** applies the rule on every retrieval-backed turn.
- **Trigger per turn** asks the model whether the current question matches the rule's trigger instruction.

### How It Works

In practice, trigger matching happens inside query interpretation. If the workspace has no trigger-based rules, Radioso skips that step entirely.

The key point is that completions are authoritative in v1. Embeddings may help narrow candidates later, but they do not decide whether a trigger rule matched.

### Practical Implication

Use **Always on** for stable preferences like language, source, or workspace-wide content type.

Use **Trigger per turn** for rules that should only apply to specific requests, such as upcoming events, time-bound courses, or schedule lookups.
