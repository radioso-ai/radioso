# Feature Specification: Message Queue Support

**Feature Branch**: `055-message-queue-support`
**Created**: 2026-05-03
**Status**: Approved by delegated CEO scope review
**Input**: User description: "My client wants message queue support because that is their default microservice landscape that they want all services to support."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dispatch Document Work Through a Message Queue (Priority: P1)

As a self-hosting operator running Radioso in a broker-based microservice environment, I want document ingestion and reprocessing jobs to be published to a message queue so worker services can be notified through the same operational pattern as the rest of my platform.

**Why this priority**: This directly satisfies the client requirement and uses Radioso's existing asynchronous document processing boundary without expanding unrelated product surfaces.

**Independent Test**: Configure Radioso with the message-queue dispatch mode, ingest or reprocess a document, and verify that a durable broker message is published while the PostgreSQL processing job remains the source of truth.

**Acceptance Scenarios**:

1. **Given** message-queue dispatch is enabled and valid broker settings are present, **When** a document processing job is queued, **Then** Radioso publishes a durable message containing the job identity and logs a successful dispatch.
2. **Given** message-queue dispatch is enabled, **When** multiple documents are reprocessed, **Then** Radioso publishes one broker message per durable job without changing the job table contract.
3. **Given** message-queue dispatch fails after the durable job has been created, **When** ingestion returns to the caller, **Then** the document remains queued, the failure is audited, and the existing worker polling fallback can still process the job.

---

### User Story 2 - Consume Broker Messages in the Worker (Priority: P2)

As a platform operator, I want the document worker to consume broker messages so queue-backed deployments can wake workers through the message broker instead of relying only on database polling or Cloud Tasks.

**Why this priority**: Publishing alone is not complete message queue support; the worker must also understand broker deliveries.

**Independent Test**: Start the worker with message-queue dispatch enabled, deliver a valid job message, and verify the worker attempts the matching durable job exactly through the existing job-claim path.

**Acceptance Scenarios**:

1. **Given** the worker is connected to the configured queue, **When** a valid job message arrives, **Then** the worker processes the durable job by id and acknowledges the message only after the attempt is accepted by the worker flow.
2. **Given** the worker receives an invalid or malformed message, **When** validation fails, **Then** the worker logs the validation failure and acknowledges or discards the message so the queue is not blocked by poison payloads.
3. **Given** a job is currently leased by another worker, **When** a duplicate message arrives, **Then** the worker reports the job as busy and requeues the message without corrupting the durable job state.

---

### User Story 3 - Operate and Document Queue Configuration (Priority: P3)

As a self-hosting operator, I want clear configuration validation and documentation for the queue mode so I can run locally with polling, in Google Cloud with Cloud Tasks, or in a broker-based microservice environment without guessing which variables are required.

**Why this priority**: Queue support affects deployment behavior and must be safe to operate.

**Independent Test**: Review the example environment file and documentation, then validate that missing required queue settings fail startup with actionable messages.

**Acceptance Scenarios**:

1. **Given** message-queue dispatch is selected without a broker URL or queue name, **When** configuration is parsed, **Then** startup fails with a clear message naming the missing setting.
2. **Given** a default local deployment, **When** no message-queue settings are provided, **Then** existing no-op polling behavior remains unchanged.
3. **Given** an operator reads the setup documentation, **When** they choose between no-op, Cloud Tasks, and message queue dispatch, **Then** the documented settings identify required values, failure behavior, and the durable PostgreSQL fallback.

### Edge Cases

- Broker delivery may happen more than once; processing MUST remain idempotent by claiming the durable PostgreSQL job by id before doing work.
- A broker message may arrive before a rescheduled job's available time; the durable job table remains authoritative and polling continues to pick up eligible retries.
- AMQP mode intentionally keeps worker polling active; broker messages are wake-up notifications and do not replace the recovery or scheduled retry loop.
- Broker outages after a job is durably queued MUST NOT lose the job or roll back the document state.
- Queue payloads may be malformed, missing fields, or reference deleted or completed jobs.
- Worker shutdown may happen while a message is being handled; the consumer MUST stop cleanly and avoid starting new message work after shutdown.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport remains in worker HTTP routes and broker consumers; orchestration remains in document ingestion/import/reprocess services and the existing document worker; durable job state remains in the document processing job repository; broker-specific behavior belongs in document infrastructure adapters.
- **Encapsulation Rule**: `DocumentProcessingWorker` must continue to own job claiming and processing decisions; ingestion and import services must depend only on `DocumentJobDispatcherPort`; `backend/src/app/composition/` owns default adapter selection and runtime wiring.
- **New Seams Required**: Add a message-queue dispatcher adapter, a message-queue consumer adapter, shared queue payload validation, and composition/runtime wiring for queue mode.
- **Anti-Goals**: Do not introduce a generic product event bus, do not move audit/chat/retrieval events onto the broker, do not replace the PostgreSQL job table as the source of truth, and do not hand-edit generated OpenAPI files.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a message-queue worker dispatch mode for document processing jobs alongside the existing no-op and Cloud Tasks modes.
- **FR-002**: System MUST publish durable broker messages for newly queued document ingestion, document import, reprocessing, and retry jobs when message-queue dispatch is enabled.
- **FR-003**: System MUST include the durable job id in every broker message and MAY include document id, workspace id, and revision as trace metadata.
- **FR-004**: System MUST consume broker messages in the document worker runtime and invoke existing job-by-id processing behavior rather than duplicating document processing logic in the consumer.
- **FR-005**: System MUST validate inbound broker message payloads before processing and safely discard malformed messages with structured logs.
- **FR-006**: System MUST acknowledge successfully handled, already completed, deleted, stale, or otherwise no-op job messages.
- **FR-007**: System MUST requeue messages when the durable job is still actively leased by another worker.
- **FR-008**: System MUST keep the durable PostgreSQL job table authoritative for status, attempts, retries, scheduling, and recovery.
- **FR-009**: System MUST fail configuration parsing when message-queue dispatch is selected without required broker settings.
- **FR-010**: System MUST preserve existing local polling behavior when dispatch mode remains no-op and preserve existing Cloud Tasks behavior when Cloud Tasks mode is selected.
- **FR-011**: System MUST emit structured logs for message publishing, consumption, malformed messages, requeues, and connection lifecycle events.
- **FR-012**: System MUST update operator-facing configuration examples and documentation for message-queue mode.

### Key Entities

- **Document Processing Job**: Existing durable record representing document work, including id, workspace, document revision, status, attempts, availability, and completion state.
- **Queue Dispatch Message**: Broker-delivered notification containing the job id and optional trace metadata used to wake worker processing.
- **Message Queue Configuration**: Operator-provided dispatch mode, broker URL, queue name, and consumer behavior settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With message-queue dispatch enabled, 100% of document ingestion and reprocessing jobs publish exactly one broker notification per durable job creation or retry dispatch attempt.
- **SC-002**: A valid broker message causes the worker to call the existing job-by-id processing path without introducing a second document processing implementation.
- **SC-003**: Invalid broker messages are discarded and logged without blocking later valid messages on the same queue.
- **SC-004**: Existing no-op and Cloud Tasks dispatch unit tests continue to pass without requiring message-queue configuration.
- **SC-005**: Documentation and `.env.example` identify all required message-queue settings and explain that PostgreSQL remains the source of truth for job recovery.

## Assumptions

- The first broker-supported implementation targets AMQP 0-9-1 / RabbitMQ-compatible queues because that is the most common standards-based broker fit for heterogeneous microservice environments.
- Message-queue support is limited to document processing worker dispatch in this feature. Broader product event streaming can be specified later if a concrete consumer and contract exist.
- Scheduled retry timing remains enforced by the PostgreSQL job table. Broker messages are wake-up notifications, not the source of truth for retry eligibility.
