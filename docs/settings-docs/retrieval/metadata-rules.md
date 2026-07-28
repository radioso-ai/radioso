---
title: "Metadata Rules"
description: "Per-agent retrieval rules that boost or filter document candidates using structured metadata fields like source and date range."
last_updated: 2026-07-27
---

# Metadata Rules

## Summary
Per-agent rules that boost or filter retrieval candidates by their document metadata rather than their text.

## Details
Text search answers "does this passage talk about the topic?" well. It is weaker at "should this passage win because it comes from the right source, language, or date range?" Metadata rules cover that second question by matching structured fields on a document — its language, source, published date, and so on — for this agent only.

A rule either boosts or filters. A boost is a soft preference: matching documents move up the ranking, but others can still be used when nothing better is available. A filter is a hard gate: any document that fails the rule is dropped, however well its text fits. So "prefer English pages" is a boost, while "only answer from official policy sources" is a filter.

These rules run every time this agent uses its `retrieval.answer` skill, which gives them a lot of leverage and makes them easy to get wrong — a mistaken key or value can quietly bias or starve retrieval on every turn without raising any error. If an agent's answers suddenly feel blinkered or oddly skewed, its metadata rules are one of the first places to look.
