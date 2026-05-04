# Research: Message Queue Support

## Decision: Use AMQP 0-9-1 / RabbitMQ-compatible queues for the first message queue adapter

**Rationale**: The client asked for support that fits a default microservice landscape. AMQP 0-9-1 is a standards-based broker protocol with broad RabbitMQ deployment usage and language interoperability. RabbitMQ's official tutorials position AMQP 0-9-1 as the default RabbitMQ protocol and include Node.js examples using `amqplib`. The `amqplib` package is the established Node.js AMQP 0-9-1 client and is published as a current npm package.

**Alternatives considered**:

- **Redis/BullMQ**: Strong Node.js job queue choice, but less language-neutral and introduces Redis-specific job semantics instead of broker notifications.
- **Kafka**: Strong event-streaming platform, but oversized for waking document workers and less aligned with existing job retry semantics.
- **Cloud Tasks only**: Already supported but cloud-provider-specific and does not satisfy self-hosted broker-first environments.
- **Generic event bus now**: Too broad without concrete external consumers; would touch audit, chat, retrieval, SDK, and docs surfaces without a clear product contract.

Sources: [RabbitMQ tutorials](https://www.rabbitmq.com/tutorials), [amqplib npm package](https://www.npmjs.com/package/amqplib), [amqplib API docs](https://amqp-node.github.io/amqplib/)

## Decision: Keep PostgreSQL as the durable job source of truth

**Rationale**: Radioso already stores document jobs in PostgreSQL and has recovery behavior for polling, lease expiry, stale revisions, deleted documents, retries, and queue repairs. Broker messages should wake workers but should not own job state, because that would duplicate retry and idempotency logic.

AMQP mode is therefore intentionally an eventing plus polling hybrid. Worker polling stays active when the AMQP consumer is enabled so broker outages, missed notifications, and scheduled retry eligibility still converge through the durable job table. `DocumentJobDispatchRequest.scheduleAt` is not serialized into AMQP messages; retry timing is governed by PostgreSQL `available_at` rather than broker-delayed delivery.

**Alternatives considered**:

- **Move job state to RabbitMQ**: Rejected because it would remove existing auditability and recovery semantics from the system of record.
- **Dual-write full job details into messages**: Rejected because message payloads would carry unnecessary customer metadata and create a second job contract.

## Decision: Add separate dispatcher and consumer ports

**Rationale**: Publishing a job notification and consuming broker deliveries have different lifecycle requirements. The existing `DocumentJobDispatcherPort` fits publishing. A new `DocumentJobConsumerPort` keeps worker-runtime lifecycle explicit without forcing all dispatchers to become long-lived consumers.

**Alternatives considered**:

- **Add start/stop to `DocumentJobDispatcherPort`**: Rejected because Cloud Tasks and no-op dispatch do not need consume lifecycle and the interface would become less precise.
- **Put AMQP consume code in `DocumentProcessingWorker`**: Rejected because the worker should remain broker-agnostic and own only durable job processing.

## Decision: Ack malformed or no-op messages, requeue busy messages

**Rationale**: Malformed messages are poison payloads; repeated delivery blocks the queue without making progress. Completed, deleted, stale, or unknown jobs are no-ops because PostgreSQL state is authoritative. Busy jobs may be actively leased by another worker and should be retried later by the broker or existing polling behavior.

**Alternatives considered**:

- **Requeue all failures**: Rejected because poison messages could loop forever.
- **Ack busy jobs**: Rejected because a duplicate delivery while a job is legitimately leased might be the only wake-up notification in a broker-driven deployment.
