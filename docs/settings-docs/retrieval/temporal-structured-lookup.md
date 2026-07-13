---
title: "Temporal Structured Lookup"
description: "How retrieval uses extracted event dates for upcoming-event and date-sorted answers."
last_updated: 2026-07-02
---

# Temporal Structured Lookup

## Summary
Use extracted event dates to retrieve, boost, and order dated event evidence.

## Details
### Overview

Temporal retrieval uses `dateFrom` and `dateTo` metadata that was added during document processing. It is most useful for questions such as "What are the next events?" or "Sort events by actuality."

### Structured Lookup

When temporal structured lookup is enabled, listing-style event date questions can look up ongoing and upcoming dated chunks directly. This helps when the question does not name a specific event.

### Upcoming Boost

Upcoming event boost gives more weight to ongoing and future dated evidence during event date lookups. It refines candidate ranking without replacing normal relevance for topic-specific questions.

### Deterministic Sort

Deterministic temporal sort orders selected dated event evidence by extracted dates before prompt assembly. Disable it only when you want model-driven ordering instead.

### Requirements

These settings need enriched chunks with valid date metadata. On an unenriched corpus, temporal retrieval has no dated evidence to use and falls back to the normal retrieval path.
