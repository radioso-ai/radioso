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
session behavior, or frontend presentation rules.

## Public Surfaces

- `contracts/`: document records, repository ports, storage ports, queue ports,
  and history DTOs shared outside the module.
- `composition.ts`: storage, dispatcher, and module wiring for application
  composition.
- `historySupport.ts`: narrow support surface for chat history presentation.

Production code outside this module should prefer these entry points over direct
imports from `services/` or `infra/`.

## Read First

- `services/documentIngestionService.ts`: upload and ingestion entry point.
- `services/documentImportService.ts`: import flows and source metadata.
- `services/documentProcessingService.ts`: processing orchestration.
- `services/documentProcessingWorker.ts`: worker runtime behavior.
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

## Tests

Focused starting points:

- `cd backend && pnpm test -- tests/unit/document-ingestion.test.ts`
- `cd backend && pnpm test -- tests/unit/document-processing-worker-runtime.test.ts`
- `cd backend && pnpm test -- tests/unit/document-import-service.test.ts`
- `cd backend && pnpm run test:integration` for processing and import flows.

Use contract tests when document API response shape changes.
