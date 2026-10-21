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

When temporal structured lookup is enabled, the lookup fetches dated chunks directly, alongside text search:

- A question that names a date or period fetches the chunks whose dates overlap it, whatever else it asks: "What's on the week of 7 December?" and "Are there Kriya courses in November?" both do. A multi-day event that starts before the period or ends after it counts. Within the period, the passages closest in meaning to the question come first, so in the second question the Kriya courses lead the other November courses. Every event's first passage comes ahead of any event's second one, so a busy week lists as many events as fit. When the question can't be embedded, the period's passages come soonest first.
- A question that asks what's coming up without naming a period or a topic fetches ongoing and upcoming events, soonest first.

The lookup reads up to 40 passages for a period, enough for a busy week. The answer always keeps the four best matches from outside the period, so "What do I need to bring to a residential course in December?" still reads your packing-list page, when search ranks it among those four, alongside December's course cards. The period's passages take the rest: the answer holds one passage per passage found plus those four, never fewer than the usual 12 and never more than 20, inside the same prompt size budget. For a busy period, the 16 passages closest to the question reach the answer.

### Upcoming Boost

Upcoming event boost gives more weight to the events a question is about: those in the requested range when it names one, otherwise ongoing and future events. It refines candidate ranking without replacing normal relevance for topic-specific questions.

### Deterministic Sort

Deterministic temporal sort orders the selected event evidence by date before prompt assembly. Events in the requested range come first, soonest first, then other ongoing and upcoming events, then undated evidence, then past events. Without a requested range, upcoming events lead and past events come last. Disable it only when you want model-driven ordering instead.

### Requirements

These settings need chunks with valid `dateFrom` and `dateTo` dates in `YYYY-MM-DD` form. On a corpus without dates, temporal retrieval has no dated evidence to use and answers through the normal retrieval path.
