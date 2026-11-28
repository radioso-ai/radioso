---
title: "Lexical Rewrite Instructions"
description: "Guidance for rewriting queries to include exact terms, abbreviations, and formal jargon the corpus likely uses."
last_updated: 2026-11-28
---

# Lexical Rewrite Instructions

## Summary
Guide the exact-term rewrite used for lexical retrieval.

## Details
### Overview

These instructions control how this agent rewrites a query for exact-term retrieval.

### Where It Helps Most

It matters most when the documents use exact terms such as:

- abbreviations
- product names
- legal citations
- policy numbers
- internal jargon

### Role Of The Instructions

They help the system include the words the corpus is likely to use, even if the user asked more casually.

When there are several exact alternatives, ask for them as whole alternatives joined by `OR`, such as `"reset token" OR "magic link"`. `OR` between whole alternatives is the one search syntax the rewrite writes, and each alternative runs as its own lexical search.

The default instructions use this for a question that names one item together with its kind. For "How much does the Planet plan cost?" the model can write `Planet plan OR Planet`, because a pricing page often heads the plan's section with its bare name and states the price there without the word "plan". The name alone also matches passages that mention it in passing, so it counts as a full match only in a section whose heading names the item, and as a partial match of `Planet plan` anywhere else. Instructions you write here replace the default ones, so keep that rule in them when your pages are sectioned that way.

### Distinction From Semantic Rewrite

Semantic rewrite focuses on meaning.

Lexical rewrite focuses on the exact words, aliases, abbreviations, and citation forms likely to appear in the source material.
