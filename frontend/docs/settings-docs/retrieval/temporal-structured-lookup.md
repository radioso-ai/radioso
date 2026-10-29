---
title: "Temporal Structured Lookup"
description: "How retrieval uses event dates to list, boost, and order events for upcoming-event and date-range questions."
last_updated: 2026-10-29
---

# Temporal Structured Lookup

## Summary
Use event dates on documents to retrieve, boost, and order dated events.

## Details
### Overview

Temporal retrieval reads the `dateFrom` and `dateTo` dates on a document's chunks, whether you set them in the document's metadata or metadata extraction found them. It answers questions such as "What are the next events?", "What's on the week of 7 December?", or "Che corsi ci sono a marzo 2027?".

When a question names a date or a period, the query rewrite resolves it against today's date (UTC) into an inclusive date range: "the week of 7 December", asked in October 2026, becomes `2026-12-07` to `2026-12-13`. The model resolves the period in whatever language the question uses, with today's weekday in hand for questions like "this weekend". The answer is told the same period and answers for it: passages dated outside it are background, mentioned only when nothing in the period matches or the visitor asks about other dates. A range longer than a year, or one that isn't a real calendar range, is set aside: the question is then answered by text search alone, with no date lookup and no upcoming-events ordering, since it asked about a period rather than about what's coming up.

### Structured Lookup

When temporal structured lookup is enabled, the lookup fetches dated chunks directly, alongside text search:

- A question that names a date or period fetches the chunks whose dates overlap it, whatever else it asks: "What's on the week of 7 December?" and "Are there Kriya courses in November?" both do. A multi-day event that starts before the period or ends after it counts. Within the period, the passages closest in meaning to the question come first, so in the second question the Kriya courses lead the other November courses. Every event's first passage comes ahead of any event's second one, so a busy week lists as many events as fit. When the question can't be embedded, the period's passages come soonest first.
- A question that asks what's coming up without naming a period or a topic fetches ongoing and upcoming events, soonest first.

The lookup reads up to 40 passages for a period, enough for a busy week, and the agent's source scope, any document scope, and its metadata rules apply to them as to every other result. Up to four places in the answer go to the best matches from outside the period, at most two per document, so "What do I need to bring to a residential course in December?" still reads your packing-list page, when search ranks it among those four, alongside December's course cards. A passage dated to another period keeps its place only when the question is about a named topic and search ranks the passage above everything in the period: "Is the yoga retreat in March?" then reads the April retreat and can give its real date. For "What's on the week of 7 December?", a summary of the week before gives its place back to the week's own events, so the answer can't mistake it for this week's. The period's passages take the rest, most relevant first and at most two per event, up to 20 passages in all. When a period has few events, the best matches from outside it, dated or not, fill the answer to the usual 12, so "Nothing on the 2nd of August — the next course starts the 16th" still has that course to point to. For a busy period, 16 to 20 of the passages closest to the question reach the answer, and the prompt lists them by date.

### Upcoming Boost

Upcoming event boost gives more weight to the events a question is about: those in the requested range when it names one, otherwise ongoing and future events. It refines candidate ranking without replacing normal relevance for topic-specific questions.

### Deterministic Sort

Deterministic temporal sort orders the selected event evidence by date before prompt assembly. Events in the requested range come first, soonest first, then other ongoing and upcoming events, then undated evidence, then past events. Without a requested range, upcoming events lead and past events come last. Disable it only when you want model-driven ordering instead.

### Requirements

These settings need chunks with valid `dateFrom` and `dateTo` dates in `YYYY-MM-DD` form. On a corpus without dates, temporal retrieval has no dated evidence to use and answers through the normal retrieval path.
