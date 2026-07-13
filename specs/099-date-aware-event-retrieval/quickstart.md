# Quickstart: Date-Aware Event Retrieval

This is an implementation validation guide, not a planning-phase command list.
Do not run these during the planning phase.

## Story 1: Enriched event date question

1. Enable workspace enrichment.
2. Set one website source enrichment override to `on`.
3. Reprocess that source.
4. Inspect stored chunks for the fixture event document.
5. Verify chunks overlapping the event carry `metadata.dateFrom` and
   `metadata.dateTo`.
6. Ask the agent when the named event takes place.
7. Verify retrieved evidence includes the dated chunk and the answer states the
   correct date.

## Story 2: Enablement controls

1. Create two sources with documents.
2. Leave workspace enrichment disabled.
3. Set source A override to `on`, source B to `inherit`.
4. Reprocess source A.
5. Verify source A documents gain enrichment provenance and temporal metadata.
6. Verify source B documents are untouched.
7. Reprocess one enriched document with override `off`.
8. Verify rebuilt chunks do not retain stale temporal metadata.

## Story 3: Next events

1. Seed an enriched corpus with three future and two past events.
2. Keep all three temporal retrieval settings enabled for an agent.
3. Ask "What are the next events?"
4. Verify staged evidence includes only ongoing/future events, soonest first.
5. Disable each temporal setting separately and verify only that behavior
   deactivates.

## Story 4: Sort by actuality

1. Use the same enriched corpus.
2. Ask for events sorted by actuality five times.
3. Verify staged evidence order is identical and date-ordered each run when
   deterministic sort is enabled.
4. Disable deterministic sort and verify model-driven ordering is allowed.

## Story 5: Workbench eval

1. Run the event-query eval suite against the deterministic enriched fixture
   corpus.
2. Verify cases cover named-event date, next-events listing, and actuality sort.
3. Verify pass/fail is based on evidence dates/order, not exact answer prose.
