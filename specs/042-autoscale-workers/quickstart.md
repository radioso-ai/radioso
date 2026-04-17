# Quickstart: Autoscaled Workers

## Goal

Validate that queued document jobs can be dispatched to request-driven workers in production configuration while local development still supports the polling worker path.

## Local validation

1. Run backend unit tests covering dispatch, lease recovery, and task handling.
2. Run integration tests covering enqueue-to-dispatch behavior and worker task HTTP processing.
3. Start local compose with `backend` and `backend-worker` and confirm polling processing still works without Cloud Tasks configuration.

## Production-style validation

1. Apply Terraform with worker queue resources and independent backend/worker scaling bounds.
2. Deploy backend and worker images.
3. Queue a burst of at least 20 documents.
4. Confirm:
   - document jobs are created durably in PostgreSQL
   - worker delivery requests are created for queued jobs
   - worker instances scale above one under load
   - worker instances return toward zero after the backlog drains
   - no document revision completes more than once
5. Run mixed chat and ingestion load and confirm backend-serving capacity scales independently from worker-serving capacity.

## Failure validation

1. Force-stop a worker during active processing.
2. Confirm a retry delivery occurs for the same job.
3. Confirm the job is reclaimed only after the lease window expires.
4. Confirm terminal failure and retry reasons remain visible in logs or audit metadata.
