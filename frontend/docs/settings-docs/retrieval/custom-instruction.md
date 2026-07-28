---
title: "Custom Instruction"
description: "Per-agent instruction field for answer formatting and style after retrieval evidence is selected."
last_updated: 2026-06-09
---

# Custom Instruction

## Summary
Add per-agent answer guidance for retrieval-backed responses.

## Details
### Overview

This is the selected agent's instruction for how retrieval-backed answers should be written.

In practice, it applies after evidence has been selected for the `retrieval.answer` skill. It affects answer behavior, not document search quality.

### Appropriate Uses

- formatting rules
- answer style
- citation style
- domain-specific response habits

### Inappropriate Uses

Do not use this as a bandage for retrieval problems.

If the wrong evidence is being found, the fix belongs in ingestion, source scope, metadata, or the agent's retrieval skill settings, not here. Use this field for how the agent explains answers once the evidence is already right.
