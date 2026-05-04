# Contract: Document Job Queue Message

## Producer

Radioso API and orchestration services publish this message through `DocumentJobDispatcherPort` after a durable document processing job exists.

## Consumer

Radioso document worker consumes this message and calls the existing job-by-id processing path.

## Queue

The configured queue must be durable. The first implementation targets AMQP 0-9-1 / RabbitMQ-compatible brokers.

AMQP messages are wake-up notifications, not the durable schedule. The message body intentionally omits `scheduleAt`; delayed retry eligibility is enforced by PostgreSQL `available_at`, and worker polling remains active in AMQP mode for recovery and scheduled retries.

## Message Body

```json
{
  "jobId": "5f98f7bd-51e2-4cb2-8bd5-0162cc6ffb89",
  "documentId": "0e4ffdb0-06d0-45da-aea7-0c70dfdbcb82",
  "workspaceId": "3519c5f5-5dd5-4f85-95b6-b58afe7c0ecf",
  "revision": 3
}
```

## Required Fields

- `jobId`: UUID string.

## Optional Fields

- `documentId`: UUID string for trace logging.
- `workspaceId`: UUID string for trace logging.
- `revision`: Positive integer for trace logging.

## Delivery Handling

- Valid processed/no-op result: acknowledge.
- Malformed payload: acknowledge and log as invalid.
- Busy durable job: reject/requeue.
- Consumer shutdown: stop accepting new deliveries and close broker resources.
