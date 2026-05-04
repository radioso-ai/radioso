# Quickstart: Message Queue Support

## Local Polling Still Works

1. Leave `WORKER_DISPATCH_DRIVER=noop`.
2. Run backend unit tests for document ingestion and worker runtime.
3. Verify existing tests pass without AMQP settings.

## AMQP Dispatch Validation

1. Set `WORKER_DISPATCH_DRIVER=amqp`.
2. Set `WORKER_AMQP_URL=amqp://localhost:5672`.
3. Set `WORKER_AMQP_QUEUE_NAME=radioso-document-jobs`.
4. Start the API and worker services.
5. Ingest a document or trigger workspace reprocessing.
6. Verify the broker receives a durable message with `jobId`.
7. Verify the worker consumes the message and the durable job transitions through the existing processing flow.

## Configuration Failure Validation

1. Set `WORKER_DISPATCH_DRIVER=amqp`.
2. Leave `WORKER_AMQP_URL` empty.
3. Start the backend.
4. Verify startup fails with a message naming `WORKER_AMQP_URL`.

## Regression Validation

Run:

```bash
cd backend
npm run test:unit -- tests/unit/amqp-document-job-queue.test.ts tests/unit/default-composition.test.ts tests/unit/runtime-config.test.ts tests/unit/document-ingestion.test.ts tests/unit/document-processing-worker-runtime.test.ts
npm run build
```
