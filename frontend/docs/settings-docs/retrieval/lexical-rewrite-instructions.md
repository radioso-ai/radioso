---
title: "Lexical Rewrite Instructions"
description: "Guidance for rewriting queries to include exact terms, abbreviations, and formal jargon the corpus likely uses."
last_updated: 2026-06-09
---

# Lexical Rewrite Instructions

## Summary
Guide the exact-term rewrite used for lexical retrieval.

## Details
### Overview

These instructions control how the system rewrites a query for exact-term retrieval.

### Where It Helps Most

It matters most when the documents use exact terms such as:

- abbreviations
- product names
- legal citations
- policy numbers
- internal jargon

### Role Of The Instructions

They help the system include the words the corpus is likely to use, even if the user asked more casually.

When there are several exact alternatives, describe the kinds of alternatives to search for. Do not ask the assistant to write raw search-engine syntax such as `OR`; Radioso handles separate lexical search options internally.

### Distinction From Semantic Rewrite

Semantic rewrite focuses on meaning.

Lexical rewrite focuses on the exact words, aliases, abbreviations, and citation forms likely to appear in the source material.
