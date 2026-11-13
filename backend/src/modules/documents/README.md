# Documents Module

Documents owns document records, upload/import flows, source content,
processing jobs, storage ports, worker execution, and document search history
support.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

Documents knows about persisted documents, source metadata, storage adapters,
processing state, job dispatch, parsing inputs, and worker recovery.

Documents should not own retrieval ranking policy, assistant persona, chat
session behavior, frontend presentation rules, or embedding provider/model
selection. Embedding-only profile jobs carry an opaque durable space ID and
workspace generation; Embedding Profiles resolves that pin to provider-owned
generation details.

Chunk persistence belongs to Documents because chunks are canonical document
records. Vector-specific write details are delegated through the retrieval-owned
chunk vector storage/vector-index adapter so Documents does not own vector index
behavior. Search-time hydration of ranked vector candidates also goes back
through canonical chunk storage before chunks are used by retrieval.

## Public Surfaces

- `contracts/`: document records, repository ports, storage ports, queue ports,
  and history DTOs shared outside the module.
- `composition.ts`: storage, dispatcher, and module wiring for application
  composition, including the exported `DocumentSourceRecrawlService`.
- `historySupport.ts`: narrow support surface for chat history presentation.
- `public.ts`: document rules other modules validate against, including
  `documentMetadataRecordSchema` — the scalar map and 16 KB ceiling every writer
  of document metadata honours, whether it arrives over HTTP or from an applied
  operator-copilot proposal — and `domain/documentRequestFields.ts`'s
  `documentRetrievalUpdateFieldsSchema` and `inlineDocumentFieldsSchema`, the
  shared field definitions the REST document routes
  (`app/http/routes/documentRouteSchemas.ts`) and the operator-copilot document
  proposal tools (`operatorCopilot/tools/documentProposals.ts`) both build their
  own request shape on top of, so the two surfaces cannot silently drift apart
  on a field name.

Production code outside this module should prefer these entry points over direct
imports from `services/` or `infra/`.

## Read First

- `services/documentIngestionService.ts`: upload and ingestion entry point.
- `services/documentImportService.ts`: import flows and source metadata.
- `services/documentSourceRecrawlService.ts`: validates a stored website source,
  resolves its persisted crawl configuration, and queues the recrawl shared by
  HTTP and operator-copilot callers.
- `services/documentProcessingService.ts`: processing orchestration.
- `domain/enrichment/generatedTagOwnership.ts`: who owns a metadata tag —
  extraction or the operator, built-in `dateFrom`/`dateTo` included — what a
  new revision projects onto its chunks, what an enrichment run and a manual
  metadata write may do to a tag, and the provenance the document API
  publishes.
  Processing and enrichment services call into it; they never decide tag
  ownership themselves.
- `services/documentEnrichmentService.ts`: one extraction run — the output
  schema, the single retry on a reply it cannot use (unreadable, cut off, or a
  dated reply with every fact dropped), and applying what the reply holds.
  Provider errors are left to the adapters' own transport retries. It asks the model through the
  `domain/enrichment/enrichmentGateway.ts` port; the adapter that implements it
  over the inference pipeline is `infra/modelDocumentEnrichmentGateway.ts`.
  Each run ends in one coded `DocumentEnrichmentRunOutcome`, which the
  processing service logs, audits, and emits as the
  `document.worker.enrichment_completed` telemetry event.
- `domain/enrichment/enrichmentReplyStore.ts`: the request fingerprint (which
  folds in the gateway's `requestProfile`) and the port for a document's last
  usable reply. A run whose request matches the stored fingerprint applies that
  reply without a model call, unless its job carries `refreshDocumentEnrichment`
  (single-document reprocess only). Saves and clears match the revision the run
  read; the adapter is `db/repositories/documentEnrichmentReplyRepository.ts`
  (`documents.enrichment_reply`), and `DocumentRepository` writes that change a
  document's title or text clear the column.
- `domain/enrichment/factQuoteLocation.ts`: places each extracted date by the
  text the model quoted, in the body offsets chunks use. A date that cannot be
  placed is dropped and counted, never fatal.
- `services/embeddingProfileJobService.ts`: resumable, generation-fenced
  embedding-only work that cannot mutate document or canonical chunk state.
- `services/documentProcessingWorker.ts`: worker runtime behavior.
- `infra/chunkRepository.ts`: canonical chunk persistence adapter.
- `infra/documentImageRepository.ts` (contracts in `contracts/documentImages.ts`):
  the `document_images` rows, the pictures a document's content carries. A
  `primary` image is the one its metadata names; an `inline` one sits in its text,
  anchored to a chunk. A row is `pending` until its renditions, re-encoded at each
  of `DOCUMENT_IMAGE_RENDITION_WIDTHS`, are written, then `stored`; `skipped` is
  one capture will not keep. Only stored rows of a live document are read.
  `listStoredForEvidence` gives retrieval the stored images of an answer's
  documents and chunks, with how many documents in the workspace share each
  primary, never where the bytes live; `findServable` gives the public image
  route the stored rendition at a width. Rows own their objects' paths.
- `services/documentJobMessage.ts`: durable job message shape.
- `services/documentJobDispatcher.ts` and `services/documentJobConsumer.ts`:
  dispatch and consume ports.

## Queue And Worker Model

The PostgreSQL job table is authoritative for status, retries, leases, and
recovery. Queue integrations such as AMQP or Cloud Tasks are wake-up mechanisms
around durable jobs, not the source of truth. Keep retry semantics aligned with
the job table and `available_at`.

When changing worker payloads or dispatch behavior, review message queue docs,
contract tests, and worker recovery tests.

Job kinds: `vectorize` makes a revision queryable; `enrich` and `images` are
its follow-ups, claimed after vectorize and embedding-profile work and never
touching the document's status. A follow-up is created through
`ensureFollowUpJob`, once per revision and kind; an `images` job that finished
is queued again when the content names new images. The message payload stays
`{ jobId }`: the worker reads the kind from the row.

## Document Images

Ingestion records the images a document's content names; the worker captures them.

- `DocumentIngestionPort.ingest({ images })` takes candidates by address: a
  website page's metadata picture and the images in its main content, a
  WordPress featured image. `domain/documentImageCandidates.ts` keeps valid
  http(s) addresses once each, at most 3 primary and 24 inline, and moves each
  inline image's offset from the ingested text into the stored text the chunks
  index. `images` absent leaves a document's images alone; an empty list says
  the content names none.
- `services/documentImageCaptureQueue.ts` records them through the
  `DocumentImageCandidateWriter`: a new address becomes a `pending` row, a kept
  one takes its new place, and one the content no longer names is released.
  It queues the `images` job after a vectorize job publishes a revision of a
  document that names any image, and at once when an unchanged page names a new
  one or still has one it keeps pending (`hasPendingKeptImage`: the first
  `MAX_STORED_IMAGES_PER_DOCUMENT` that are not skipped), so a timeout, a busy
  codec or a spent budget is retried on the next sync.
- `services/documentImageCaptureService.ts` runs the `images` job: it fetches
  each image through `fetchPublicBytes` (public addresses only, every redirect
  re-checked, 8 seconds, 15 MB), conditionally with the stored entity tag,
  re-encodes it through `shared/infra/images` (`infra/documentImageCodec.ts`),
  stores the WebP copies as `document-image-<id>-w<width>` under the
  workspace's documents folder, and anchors an inline image to the chunk whose
  offsets hold it. Images under 200 px on the short side, unreadable types and
  refused addresses are `skipped`; a timeout leaves the row `pending`. A
  document keeps at most 12 images. A failed image never fails the job.
- A deleted document releases its images (`document_id` turns NULL), so they
  stop being served at once, and `markStored` and `reanchor` leave a released
  row alone (capture then deletes the copies it wrote). Once a minute, on the
  worker's tick, idle or not, the sweep deletes a batch of released rows'
  copies, then each row whose copies are all gone; a row with a copy left goes
  to the back of the queue. Every way a document goes (one at a time, with its
  source, reaped by a crawl) cleans up the same way; deleting a workspace
  deletes its image rows in the deletion (`deleteForWorkspaces`, from
  `app/composition/workspaceDeletion.ts`), and its storage purge takes the
  copies.
- `getDocument` lists the document's images (`DocumentImageListing`) with
  their role, status and `siteWide` (retrieval's banner rule, as an answer
  applies it), and the public image route's address of each stored copy,
  which composition adds (`addressedDocumentImageListing` over
  `DocumentImageRows`).
- The answer side asks `listStoredForEvidence` to count the documents sharing
  a primary only up to `primaryDocumentCountLimit` (retrieval's banner rule
  passes one past its threshold); the partial index covers `document_id`.
- Observability: `document_image_capture_total{source, outcome}`,
  `document_image_capture_duration_seconds`, and the `document.images.capture`
  span under `document.worker.job`. Logs carry ids only, never addresses, alt
  text or bytes.

## Stored Files Of Deleted Workspaces

Every object a storage adapter writes sits under `workspaces/<workspaceId>/`,
so `DocumentStorageInventoryPort` (`contracts/storage.ts`) finds a workspace's
objects by its id alone, whatever path an older release gave them below it.
Composition wires a `DocumentStorageAdapter`: the object port, the locator and
the inventory together, in the GCS and local adapters alike. `locate` says where
an upload with given ids lands before anything is written, so a caller (visitor
photos) records the object first and never leaves one no row names.

- `services/workspaceStoragePurge.ts`: the `documents.workspace_storage_purge`
  background job, keyed `<origin>:<workspaceId>`. A workspace or organization
  deletion enqueues one per workspace inside its own transaction
  (`handOffWorkspaceStoragePurges`, origin `workspace_deletion`, wired by
  `app/composition/workspaceDeletion.ts`), so the hand-off commits with the
  deletion. A run deletes up to ten batches of 100 objects, asks for a rerun
  when more remain, retries failed deletes over about a day, and records a
  `workspace.stored_files.deleted` audit event with the count. It keeps the
  files of a workspace that still exists, and, for origin `orphan_sweep`, of a
  prefix written to in the last 24 hours, checked when it runs. Its payload
  accepts only a canonical lowercase workspace id.
- `services/orphanedWorkspaceStorageReport.ts`: what an orphan sweep would
  queue, read from the whole store. The operator command
  (`src/workspaceStorageSweep.ts`, logic in
  `src/app/cli/workspaceStorageSweepCommand.ts`) prints it as a dry run, and with
  `--apply --expect-orphans <n>` scans again, refuses a different count, and
  queues one `orphan_sweep` purge per workspace in the report it printed;
  nothing queues purges on its own. The report counts only canonical lowercase
  workspace ids absent from the database whose newest object is more than a day
  old. Its ownership check proves only that the store holds some of this
  database's files: a store shared with another deployment passes it, and that
  deployment's workspaces read as orphaned, which is why the step is manual and
  each deployment needs its own bucket or folder.

Purges reach only the store composition is configured with
(`DOCUMENT_STORAGE_BUCKET` or `DOCUMENT_STORAGE_LOCAL_PATH`). Upload paths and
listings derive from `WORKSPACE_STORAGE_ROOT` and `workspaceStoragePrefix`, so
the layout the inventory relies on is decided in one place.

Purge payloads carry a workspace id and an origin only. An object path never
goes into a job, a log line, or an audit event, because paths written before
storage dropped filenames carry them.

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/document-ingestion.test.ts`
- `cd backend && pnpm test -- tests/unit/document-processing-worker-runtime.test.ts`
- `cd backend && pnpm test -- tests/unit/documents/embeddingProfileJobService.test.ts`
- `cd backend && pnpm test -- tests/unit/document-import-service.test.ts`
- `cd backend && pnpm test -- tests/unit/document-source-recrawl-service.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/document-date-ownership.test.ts tests/unit/document-generated-tag-ownership.test.ts`
  for tag ownership across PUT, reprocess, failed runs, and manual edits.
- `cd backend && pnpm exec vitest run tests/unit/document-enrichment-service.test.ts tests/unit/document-enrichment-gateway.test.ts tests/unit/document-enrichment-quote-location.test.ts`
  for extraction retries, reply reading, and placing dates by their quotes.
- `cd backend && pnpm exec vitest run tests/unit/document-enrichment-reply-reuse.test.ts tests/unit/document-enrichment-unchanged-content.test.ts`
  for reusing a stored reply, and re-crawls, re-sent documents, reprocesses,
  and metadata edits that make no model call.
- `cd backend && pnpm exec vitest run tests/unit/workspace-storage-cleanup.test.ts tests/unit/workspace-storage-sweep-command.test.ts tests/unit/local-document-storage.test.ts tests/unit/gcs-document-storage.test.ts`
  for removing a deleted workspace's stored files, and
  `tests/integration/workspace-storage-purge.integration.test.ts` for the
  hand-off committing with the deletion.
- `cd backend && pnpm run test:integration` for processing and import flows.
- `cd backend && pnpm exec vitest run tests/unit/documents/document-image-candidates.test.ts tests/unit/documents/document-image-capture.test.ts tests/unit/documents/document-image-capture-queue.test.ts tests/unit/documents/document-worker-images.test.ts`
  for placing, recording, capturing and sweeping document images.
- `cd backend && pnpm exec vitest run tests/integration/document-image-repository.integration.test.ts tests/integration/document-image-capture.integration.test.ts`
  for the image rows, and a crawled page through the worker to an answer's offer.

Use contract tests when document API response shape changes.
