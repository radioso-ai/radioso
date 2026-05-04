# Data Model: Message Queue Support

## Existing Entity: Document Processing Job

Durable PostgreSQL record that remains authoritative for all document work.

Fields used by this feature:

- `id`: Stable job identifier included in broker messages.
- `documentId`: Document being processed.
- `workspaceId`: Workspace scope for auditing and trace correlation.
- `documentRevision`: Document revision protected by stale-job checks.
- `status`: `queued`, `processing`, `completed`, `failed`, or `skipped`.
- `attemptCount`: Existing retry attempt counter.
- `availableAt`: Existing retry eligibility timestamp.
- `claimedAt`: Existing lease timestamp.

Lifecycle remains unchanged:

```text
queued -> processing -> completed
queued -> processing -> skipped
queued -> processing -> failed
queued -> processing -> queued (retry)
```

## New Entity: Queue Dispatch Message

Broker notification used to wake document workers. It is not a durable source of truth.

Required fields:

- `jobId`: UUID of the durable document processing job.

Optional trace fields:

- `documentId`: UUID of the document.
- `workspaceId`: UUID of the workspace.
- `revision`: Positive document revision number.

Validation rules:

- `jobId`, when present fields `documentId` and `workspaceId`, must be UUIDs.
- `revision`, when present, must be a positive integer.
- Unknown fields are ignored.
- Invalid payloads are logged and discarded.

## New Entity: Message Queue Configuration

Environment-backed operator settings for queue mode.

Fields:

- `WORKER_DISPATCH_DRIVER`: `noop`, `cloud-tasks`, or `amqp`.
- `WORKER_AMQP_URL`: Broker URL required when `WORKER_DISPATCH_DRIVER=amqp`.
- `WORKER_AMQP_QUEUE_NAME`: Queue name required when `WORKER_DISPATCH_DRIVER=amqp`.
- `WORKER_AMQP_PREFETCH`: Optional positive integer controlling consumer prefetch; default is `1`.

Validation rules:

- AMQP settings are optional when dispatch mode is not `amqp`.
- AMQP URL and queue name are required when dispatch mode is `amqp`.
- Prefetch must be a positive integer.
