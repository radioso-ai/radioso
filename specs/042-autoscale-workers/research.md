# Research: Autoscaled Workers

## Decision: Use Cloud Tasks for production worker dispatch and keep the database job table as the source of truth

### Rationale

- The existing `document_processing_jobs` table already models queue state, retries, and revision ownership.
- Cloud Run scales on requests, not on queued PostgreSQL rows, so production workers need request-driven delivery to scale from zero.
- Cloud Tasks can deliver one request per queued job to the worker service while the database still decides whether the job is claimable.

### Alternatives considered

- Pub/Sub push delivery: rejected for this feature because per-job HTTP dispatch with explicit schedule times maps more directly to retry timing and lease-aware redelivery.
- Keep only the polling worker: rejected because it does not provide request-driven autoscaling from zero.
- Replace the durable database queue with Cloud Tasks as the only queue: rejected because current document status, retries, and revision ownership already rely on PostgreSQL and must remain durable there.

## Decision: Treat delivery tasks as hints and job rows as ownership

### Rationale

- Duplicate or delayed delivery must remain harmless.
- Job ownership already belongs naturally in `document_processing_jobs`, where claims can be guarded transactionally.
- This preserves idempotency when two delivery attempts arrive for the same job or when a retry arrives after a newer revision exists.

### Alternatives considered

- Trust the delivery request as ownership: rejected because duplicate delivery would create double-processing risk.
- Assign jobs from an in-memory coordinator: rejected because it breaks horizontal scaling and failover.

## Decision: Add lease-based recovery for job-by-id task processing

### Rationale

- A worker can die after claiming a job but before returning success to Cloud Tasks.
- Retried delivery of the same job must eventually reclaim abandoned work without manual database edits.
- A bounded lease window allows fresh in-flight work to remain protected while stale claims can be safely re-queued.

### Alternatives considered

- Never reclaim `processing` jobs in task mode: rejected because dead workers would strand work indefinitely.
- Immediately reclaim any `processing` job on duplicate delivery: rejected because slow but healthy workers would double-process.

## Decision: Keep the polling worker as the local and fallback runtime

### Rationale

- Local Docker and host workflows do not have Cloud Tasks by default.
- The current polling worker provides a low-friction way to preserve development ergonomics and existing tests.
- Sharing the same single-job processing logic across polling and task runtimes reduces divergence.

### Alternatives considered

- Remove polling entirely: rejected because it would make local development and regression testing harder than necessary.
- Run both poll and task modes in production: rejected for this feature because it complicates ownership and can cause needless duplicate wake-ups.

## Decision: Expose independent scaling bounds for backend chat traffic and worker task traffic

### Rationale

- Chat latency depends on backend-serving capacity, not worker count.
- Document processing throughput depends on worker task capacity, not backend-serving count.
- Independent Terraform variables keep tuning straightforward and align with the approved spec.

### Alternatives considered

- Tie worker count to backend count: rejected because mixed chat and ingestion load patterns differ.
- Hide scaling configuration inside code: rejected because operators need explicit infrastructure controls.
