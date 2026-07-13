# Data Model: Date-Aware Event Retrieval

## Document Shape

- Values: `event`, `article`, `profile`, `reference`, `generic`.
- Stored in document enrichment provenance.
- Unknown or low-confidence output normalizes to `generic`.
- Owned by `backend/src/modules/documents/domain/enrichment/`.

## Temporal Fact

- Fields:
  - `id`: stable fact id from enrichment output or generated during validation.
  - `label`: model-provided fact label.
  - `dateFrom`: ISO 8601 date string when resolved.
  - `dateTo`: ISO 8601 date string when resolved; may equal `dateFrom`.
  - `unresolvedText`: optional original temporal phrase when unresolved.
  - `sourceRange`: `{ start: number; end: number }` character offsets in the
    bounded document representation.
  - `anchor`: `source_last_sync` or `document_created_at` when relative dates
    are resolved.
- Validation:
  - Ranges must be in bounds and `start < end`.
  - Dates must be parseable ISO dates and `dateFrom <= dateTo` when both exist.
  - Invalid facts fail enrichment validation for the document run.

## Enrichment Provenance

- Stored at document level.
- Fields:
  - `shape`: `DocumentShape`.
  - `model`: model id used for enrichment.
  - `enrichedAt`: timestamp.
  - `anchorDate`: ISO date used for relative resolution.
  - `anchorSource`: `source_last_sync` or `document_created_at`.
  - `status`: `applied`, `skipped`, or `failed`.
  - `failureReason`: safe operator-facing failure code/message, no prompt,
    completion, or document text.
  - `factCount`, `appliedChunkCount`.

## Enrichment Enablement

- Workspace default:
  - Add ingestion setting `documentEnrichmentEnabled`, default `false`.
- Source override:
  - Add source config field `documentEnrichmentOverride` with `inherit`, `on`,
    `off`.
- Run override:
  - Add processing job option `documentEnrichmentOverride` with `on` or `off`.
- Resolution:
  - job override, else source override, else workspace default.

## Processing Job Options

- Stored on `document_processing_jobs.options` as nullable JSONB.
- Current v1 shape:
  - `documentEnrichmentOverride?: "on" | "off"`.
- Must be returned by job repository claim/find methods and preserved through
  retry/reschedule on the same job row.
- Must not be included in `DocumentJobQueueMessage`.

## Chunk Temporal Columns

- Existing chunk metadata remains JSONB and stores `dateFrom`/`dateTo`.
- Add generated date columns derived from metadata:
  - `date_from`
  - `date_to`
- Index for workspace-scoped temporal lookup and ordering.
- Backfill occurs automatically by generated column evaluation for existing
  rows; existing rows without metadata dates remain null.

## Temporal Retrieval Settings

- Flat fields in `RetrievalSettingsRecord` and `retrieval.answer` settings:
  - `temporalStructuredLookupEnabled`: default `true`.
  - `temporalBoostUpcomingEnabled`: default `true`.
  - `temporalDeterministicSortEnabled`: default `true`.
- Per-agent overrides are parsed by `backend/src/app/composition/skillSettingsResolver.ts`.
- Frontend serialization mirrors backend fields in `frontend/lib/retrieval-skill-settings.ts`.

## Query Interpretation Temporal Mode

- Field on structured rewrite result:
  - `temporalQueryMode`: `none`, `listing`, or `topic_refinement`.
- Only model output sets this field.
- Retrieval uses it only when `queryShape` is `event_date_lookup`.

## Enriched Fixture Corpus

- Deterministic test/eval corpus with:
  - one named event whose date is in a later paragraph,
  - multiple future events,
  - past events,
  - article/profile/generic documents,
  - induced enrichment failure fixture.
- Expected outcomes assert evidence dates and staged order, not exact prose.
