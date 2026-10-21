---
title: "Temporal Structured Lookup"
description: "How retrieval uses event dates to list, boost, and order events for upcoming-event and date-range questions."
last_updated: 2026-10-21
---

# Temporal Structured Lookup

## Summary
Use event dates on documents to retrieve, boost, and order dated events.

## Details
### Overview

Temporal retrieval reads the `dateFrom` and `dateTo` dates on a document's chunks, whether you set them in the document's metadata or metadata extraction found them. It answers questions such as "What are the next events?", "What's on the week of 7 December?", or "Che corsi ci sono a marzo 2027?".

When a question names a date or a period, the query rewrite resolves it against today's date (UTC) into an inclusive date range: "the week of 7 December", asked in October 2026, becomes `2026-12-07` to `2026-12-13`. The model resolves the period in whatever language the question uses. A range longer than a year is set aside, and the question is answered as an upcoming-events question.

### Structured Lookup

When temporal structured lookup is enabled, a question that lists events without naming a topic fetches dated chunks directly, alongside text search:

- With a requested range, it fetches the events whose dates overlap the range, including a multi-day event that starts before it or ends after it. Every event's first passage comes ahead of any event's second one, so a busy week lists as many events as fit.
- Without one, it fetches ongoing and upcoming events, soonest first.

An answer that lists the events in a requested range holds one passage per passage the lookup found there, never fewer than the usual 12 and never more than 20, inside the same prompt size budget. That covers a busy week; for a longer period with more events than that, the answer draws on the earliest 20.

A question about a topic in a period, such as "meditation courses in December", runs the normal topic search. The range then decides which of those results rank higher and come first.

### Upcoming Boost

Upcoming event boost gives more weight to the events a question is about: those in the requested range when it names one, otherwise ongoing and future events. It refines candidate ranking without replacing normal relevance for topic-specific questions.

### Deterministic Sort

Deterministic temporal sort orders the selected event evidence by date before prompt assembly. Events in the requested range come first, soonest first, then other ongoing and upcoming events, then undated evidence, then past events. Without a requested range, upcoming events lead and past events come last. Disable it only when you want model-driven ordering instead.

### Requirements

These settings need chunks with valid `dateFrom` and `dateTo` dates in `YYYY-MM-DD` form. On a corpus without dates, temporal retrieval has no dated evidence to use and answers through the normal retrieval path.
