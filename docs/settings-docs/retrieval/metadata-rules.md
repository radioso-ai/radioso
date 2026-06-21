---
title: "Metadata Rules"
description: "Per-agent retrieval rules that boost or filter document candidates using structured metadata fields like source and date range."
last_updated: 2026-06-09
---

# Metadata Rules

## Summary
Per-agent rules that boost or filter candidates using document metadata.

## Details
### Overview

Metadata rules guide this agent's retrieval using structured document fields rather than text alone.

Examples:

- prefer English documents
- only search official sources
- filter out old versions
- boost content from a certain domain

### Why It Matters

Text retrieval is good at "does this passage talk about the topic?"

It is not always good at "should this passage be preferred because it comes from the right source, language, or date range?"

Metadata rules solve that second problem.

### Available Behaviors

- **Boost:** soft preference
- **Filter:** hard gate

Boost says:

> "Prefer documents like this if possible."

Filter says:

> "Do not use documents unless they match this rule."

### Risk Profile

These rules are powerful because they run whenever this agent uses the `retrieval.answer` skill.

That means a bad rule can quietly distort retrieval for this agent.

If retrieval suddenly feels blind or strangely biased, metadata rules are one of the first things to inspect.
