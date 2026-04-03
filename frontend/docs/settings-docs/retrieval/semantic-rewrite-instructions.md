# Semantic Rewrite Instructions

## Summary
Guide the meaning-preserving rewrite used for semantic retrieval.

## Details
### Overview

These instructions control how the system rewrites a query for semantic retrieval.

### Objectives

It should:

- preserve the user's real intent
- resolve vague references from conversation context
- turn follow-ups into standalone search queries

### Failure Mode

It should not quietly invent a different question.

That is the core risk with rewrite: if it becomes too "helpful," it can drift away from what the user actually meant.

### What To Preserve

- subject identity
- proper nouns
- timeframes
- constraints
- whether the user wants explanation, comparison, exception, or procedure

### Tuning Guidance

If follow-up questions are being misunderstood, tighten this setting before touching lower-level retrieval thresholds.
