# Data Model: Autoscaled Workers

## Document Processing Job

- Purpose: Durable source of truth for one document revision's processing lifecycle.
- Existing fields used by this feature:
  - `id`
  - `documentId`
  - `workspaceId`
  - `documentRevision`
  - `status`
  - `attemptCount`
  - `lastError`
  - `availableAt`
  - `claimedAt`
  - `completedAt`
  - `createdAt`
  - `updatedAt`
- State transitions:
  - `queued` -> `processing` when claimed
  - `processing` -> `completed` on success
  - `processing` -> `queued` on retry scheduling
  - `processing` -> `failed` on terminal failure
  - `processing` -> `skipped` on stale revision or deleted document
- Recovery rule:
  - a `processing` job with a stale `claimedAt` can be moved back to `queued` and reclaimed

## Worker Delivery Task

- Purpose: Request-driven wake-up signal that asks the worker service to attempt one durable job.
- Fields:
  - `jobId`
  - `documentId`
  - `workspaceId`
  - `revision`
- Rules:
  - delivery may be duplicated, delayed, or retried
  - delivery is not authoritative for job ownership
  - successful processing depends on the durable job row still being claimable

## Worker Dispatch Configuration

- Purpose: Operator-managed settings that choose how queued jobs are dispatched.
- Fields:
  - `dispatchDriver`
  - `queueName`
  - `queueLocation`
  - `workerServiceUrl`
  - `workerInvokerServiceAccount`
  - `jobLeaseMs`
  - `workerMinInstances`
  - `workerMaxInstances`
  - `backendMinInstances`
  - `backendMaxInstances`
- Rules:
  - backend-serving and worker-serving bounds remain independently configurable
  - local/default configuration may disable external task dispatch and rely on polling

## Queue Telemetry Snapshot

- Purpose: Operator-facing summary of current backlog health.
- Fields:
  - `queuedJobCount`
  - `processingJobCount`
  - `oldestQueuedJobCreatedAt`
- Derived metrics:
  - oldest queued age
  - retry pressure
  - terminal failure counts from audit or logs

## Worker Runtime Role

- Purpose: Dedicated runtime that accepts internal task delivery, claims durable jobs, processes them, and returns retryable or terminal HTTP outcomes.
- Responsibilities:
  - attempt claim by durable job identity
  - defer duplicate in-flight retries until lease expiry
  - reclaim stale claims
  - execute the shared document processing flow
  - reschedule delivery when retries are needed
