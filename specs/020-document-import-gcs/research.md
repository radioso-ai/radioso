# Research: Document Import and GCS Storage

## Decision: Add a dedicated multipart import endpoint instead of overloading the existing JSON document route

**Rationale**: The current `/api/v1/document/` route already serves the manual text create and edit flow. A separate `/api/v1/document/import` endpoint keeps transport handling simple, preserves existing JSON validation, and prevents route logic from branching deeply on content type.

**Alternatives considered**:
- Accept both JSON and multipart on `/api/v1/document/`: rejected because it would make the route and API client harder to reason about and would blur the distinction between text-backed and file-backed documents.
- Replace the manual text route entirely: rejected because the approved spec keeps the current text workflow available.

## Decision: Parse uploaded files during async document processing, not during the upload request

**Rationale**: Upload acceptance should stay fast and deterministic: validate, store object, create document row, queue work. Parsing in the worker also satisfies reprocessing from the stored original file and avoids duplicating extraction logic between upload and retry paths.

**Alternatives considered**:
- Parse during upload and persist extracted text immediately: rejected because it makes upload latency unpredictable and forces reprocess to either re-run parsing in a second code path or reuse stale extracted text.
- Parse in the frontend before upload: rejected because it would leak parser concerns into the client and create browser compatibility and security issues.

## Decision: Store imported-file source metadata as additive columns on `documents`

**Rationale**: Imported file state belongs to the document lifecycle. Additive columns keep lookups and deletion simple, avoid a new join table, and fit the existing repository pattern where one row represents the latest accepted document revision.

**Alternatives considered**:
- Separate `document_sources` table: rejected because it adds more coordination and joins without a clear benefit for the first supported source type.
- Store all source metadata in `metadata` JSONB only: rejected because critical workflow fields such as source kind and object path should be strongly typed and easy to query.

## Decision: Introduce a storage port with a GCS-backed adapter using ADC-compatible credentials

**Rationale**: A storage port keeps GCS concerns out of routes and document orchestration. Using Google client default credentials supports Cloud-hosted execution without key files and local development via `GOOGLE_APPLICATION_CREDENTIALS` or equivalent ADC login, while keeping secrets out of source control.

**Alternatives considered**:
- Call GCS directly from document services: rejected because it violates the feature’s modularity boundary.
- Commit a service-account key for localhost: rejected because it violates secrets hygiene.

## Decision: Ship the parser as a local runtime package that matches the current `/packages` import pattern

**Rationale**: The backend already consumes `@hivec/connector-api` via a local `file:` package dependency. A new `@hivec/document-parser` package with runtime ESM exports and declaration files preserves that consumption pattern without introducing a monorepo build system change.

**Alternatives considered**:
- Keep parser code under `backend/src/`: rejected because the approved spec requires a package with no core-code dependency.
- Add a new repository-wide package build pipeline first: rejected as unnecessary scope for the feature.

## Decision: Use format-specific parser adapters behind one package entrypoint

**Rationale**: PDF, DOCX, TXT, and XLSX have materially different extraction rules. A single package entrypoint should dispatch by detected file type while keeping each parser adapter isolated. This makes it easier to handle sheet naming, plain-text normalization, and parser-specific errors without conditional sprawl.

**Alternatives considered**:
- One large parser file: rejected because it would be harder to maintain and test.
- Only support TXT and PDF initially: rejected because the approved scope explicitly includes DOCX and XLSX.

## Decision: Keep manual text edit/create and imported-file flows separate in the frontend

**Rationale**: The existing dialog is built for inline text authoring. Imported files have different inputs, validation, and lifecycle. A separate import action keeps the UI understandable and avoids accidental conversion of file-backed documents into manual text documents.

**Alternatives considered**:
- Reuse the same dialog for both text and file imports: rejected because it creates conflicting form states and unclear edit semantics.
- Remove the manual text path: rejected because the spec keeps it available.

## Decision: Delete stored objects before deleting file-backed document rows

**Rationale**: This prevents orphaned source files. If object deletion fails, the request can fail safely and the document remains retryable, satisfying the spec’s requirement for recoverable cleanup failures.

**Alternatives considered**:
- Delete the DB row first and clean up storage asynchronously later: rejected because it risks silent object orphaning without an existing cleanup queue.
- Ignore storage deletion failures: rejected because it would violate the spec and weaken customer data handling.
