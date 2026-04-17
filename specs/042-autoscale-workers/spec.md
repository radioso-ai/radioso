# Feature Specification: Autoscaled Workers

**Feature Branch**: `042-autoscale-workers`  
**Created**: 2026-04-16  
**Status**: Draft  
**Input**: User description: "Prepare scalable autoscaled document workers and backend chat scaling so worker capacity can multiply under load and scale back down"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Process document backlogs without manual intervention (Priority: P1)

As an operator, I want document processing capacity to increase automatically when many documents are queued so that imports and reprocessing jobs do not stall behind a single busy worker.

**Why this priority**: Slow document ingestion directly delays customer-visible readiness and blocks downstream retrieval quality.

**Independent Test**: Queue a burst of document processing work larger than one worker can finish promptly and verify that multiple workers process the backlog concurrently while each document revision is processed at most once.

**Acceptance Scenarios**:

1. **Given** many queued documents, **When** backlog age or queue depth rises above normal steady-state load, **Then** the system increases worker capacity without an operator manually starting more workers.
2. **Given** a queued document revision has already been claimed by one worker, **When** another worker competes for work at the same time, **Then** only one worker processes that specific revision and the others claim different work or remain idle.
3. **Given** load returns to normal and no eligible document jobs remain, **When** autoscaling settles, **Then** excess worker capacity scales back down without losing queued, retried, or in-flight work state.

---

### User Story 2 - Keep chat responsive while document work is busy (Priority: P1)

As a chat user, I want answer generation latency to stay stable even while large document imports or reprocessing jobs are underway so that background ingestion load does not make the assistant feel stuck.

**Why this priority**: Chat responsiveness is the primary interactive experience and must not degrade because background workers are saturated.

**Independent Test**: Run chat traffic while document processing load is active and verify the backend can add serving capacity independently of worker capacity.

**Acceptance Scenarios**:

1. **Given** sustained chat traffic and simultaneous document processing load, **When** the system needs more serving capacity, **Then** chat-serving capacity can scale independently from document-worker capacity.
2. **Given** long-lived streaming chat responses, **When** more concurrent chat sessions arrive, **Then** the platform adds serving instances before active users experience prolonged queueing or timeouts.

---

### User Story 3 - Operate scaling safely with clear signals (Priority: P2)

As an operator, I want queue depth, backlog age, retries, and worker outcomes to be visible so that I can tune scaling behavior and diagnose overload or failure patterns.

**Why this priority**: Autoscaling without observability creates hidden failure modes and makes tuning guesswork.

**Independent Test**: Generate normal load, overload, and failure cases and verify the system exposes enough signals to distinguish backlog growth, retry storms, and healthy drain-down.

**Acceptance Scenarios**:

1. **Given** a growing document backlog, **When** operators inspect runtime signals, **Then** they can see queued volume, processing volume, oldest queued age, and failure or retry counts.
2. **Given** a worker fails while processing a document, **When** retries or terminal failures occur, **Then** the failure reason and job outcome remain visible without duplicate processing ambiguity.

### Edge Cases

- What happens when a worker receives a trigger for a document revision that has already been superseded by a newer revision?
- What happens when the scaling platform delivers the same job trigger more than once?
- How does the system recover if a worker stops after claiming work but before marking it complete?
- How does the system behave when chat demand spikes but document backlog is near zero?
- How does the system fail safely when the triggering mechanism is unavailable but the durable document job record was already created?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Runtime scalability changes MUST preserve durable auditability for document outcomes and must not weaken existing workspace isolation guarantees.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Document ingestion transport remains in HTTP routes and import services, document queue state remains in persistence repositories, worker orchestration remains in a focused worker runtime layer, and document transformation or embedding logic remains in document processing services. Chat transport remains in chat routes, while conversation persistence and retrieval orchestration stay in existing chat and retrieval services.
- **Encapsulation Rule**: Existing route handlers and runtime entrypoints must remain orchestration-only. The document job repository must remain persistence-only and must not absorb scaling policy. The chat service must not absorb document queue management responsibilities.
- **New Seams Required**: Introduce a focused trigger-dispatch seam for document jobs, a focused worker job handler seam that can process a single claimed job safely under autoscaling, and a focused scaling-configuration seam for chat-serving capacity versus worker capacity.
- **Anti-Goals**: Do not keep adding scaling logic to the current long-lived polling loop. Do not couple chat-serving scale decisions to document queue depth. Do not rely on in-memory worker state as the source of truth for retries, deduplication, or job ownership.

## Allocation, Idempotency, and Failover Rules *(mandatory)*

- Worker ownership MUST be decided by claiming durable queued job records rather than by trusting an in-memory coordinator or the delivery trigger itself.
- Delivery triggers MUST act only as wake-up signals to request processing and MUST remain safe when delayed, duplicated, or delivered out of order.
- Workers MUST verify the current document revision and job state before doing expensive processing so stale revisions, deleted documents, and already-terminal jobs become safe no-op outcomes.
- The system MUST use a recoverable claim model for in-flight work so jobs abandoned by interrupted workers can become eligible again after a bounded recovery window.
- Final document and chunk publication MUST stay revision-aware so an older recovered job cannot overwrite the outcome of a newer revision.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support automatic horizontal scaling of document-processing workers based on queued work so capacity can grow above one worker during backlog conditions and return to a lower steady state after backlog drain.
- **FR-002**: System MUST preserve a durable job record for each document revision so worker scaling, retries, and recovery do not depend on any single worker instance staying alive.
- **FR-003**: System MUST ensure each eligible document revision is processed at most once at a time, even when multiple workers attempt to claim work concurrently.
- **FR-004**: System MUST treat duplicate or delayed worker triggers as safe no-op or idempotent reprocessing attempts rather than producing duplicate chunk state or conflicting final statuses.
- **FR-005**: System MUST recover claimed but unfinished work after worker interruption without requiring manual database repair for normal restart scenarios.
- **FR-005a**: System MUST support claiming work by durable job identity so a triggered worker can attempt to process a specific job while the database still decides whether that claim is valid.
- **FR-005b**: System MUST use a bounded claim-expiry or lease-recovery rule so interrupted in-flight jobs can be safely retried by later workers.
- **FR-006**: System MUST allow document-worker capacity to scale independently from chat-serving capacity.
- **FR-007**: System MUST allow chat-serving capacity to scale up during concurrent streaming demand without requiring additional document workers.
- **FR-008**: System MUST expose operator-visible signals for queued job count, processing job count, oldest queued age, retry activity, and terminal failures.
- **FR-009**: System MUST preserve existing document status semantics so users can still tell whether a document is queued, processing, ready, skipped, or failed.
- **FR-010**: System MUST record enough outcome metadata for operators to distinguish overload, transient worker failure, stale revision skips, and permanent processing failures.
- **FR-011**: System MUST allow operators to configure scaling bounds for worker capacity separately from scaling bounds for chat-serving capacity.
- **FR-012**: System MUST fail safely when background triggering is unavailable by preventing silent data loss and making the stuck state observable to operators.

### Key Entities *(include if feature involves data)*

- **Document Processing Job**: A durable record representing work for one document revision, including readiness time, claim state, retry history, and terminal outcome.
- **Worker Trigger**: A delivery attempt that asks a worker to process queued document work without being the source of truth for job state.
- **Scaling Policy**: Operator-managed limits and thresholds that govern how much worker capacity and chat-serving capacity may grow or shrink.
- **Queue Telemetry Snapshot**: Operator-facing measurements summarizing backlog size, age, processing volume, and failure pressure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: During a burst test with at least 20 simultaneously queued document jobs, the system increases active worker capacity above one worker and reduces oldest queued age by at least 50% versus the current single-worker baseline.
- **SC-002**: In the same burst test, no document revision is completed more than once and no final document status becomes inconsistent because of concurrent workers.
- **SC-003**: After queued work drains to zero, worker capacity scales back down without leaving more than 1% of jobs stranded in a non-terminal claimed state for longer than 2 polling or retry windows.
- **SC-004**: Under a mixed-load test with concurrent chat streaming and document ingestion, p95 chat response start time degrades by no more than 20% relative to an equivalent chat-only test at the same request volume.
- **SC-005**: Operators can inspect a single dashboard or log query and determine current queued count, processing count, oldest queued age, retry volume, and terminal failure count for the environment under test.
- **SC-006**: A forced worker termination during active document processing results in automatic recovery or explicit terminal failure visibility for 100% of affected jobs without manual database edits.
