# Research: Async Document Processing

## Decision: Use PostgreSQL as the durable processing queue

**Rationale**: The repository already depends on PostgreSQL and persists all document state there. A database-backed job table provides durability across process restarts without introducing new infrastructure or scope beyond the approved spec.

**Alternatives considered**:
- In-memory queue: rejected because accepted work would be lost on restart and would not satisfy the durability requirement.
- Redis/BullMQ or an external broker: rejected for the initial release because it adds new infrastructure and operational scope not required by the approved feature.

## Decision: Track document revisions explicitly and bind each job to a revision

**Rationale**: Async processing creates race conditions. A revision number on the document plus a matching revision on each processing job makes it possible to detect stale work before publishing chunks or final status.

**Alternatives considered**:
- Compare timestamps only: rejected because it is easier to mis-handle clock resolution and equal timestamps.
- Delete older jobs aggressively: rejected because stale jobs can still be in-flight at execution time and need a publish-time guard.

## Decision: Run a background worker from the backend process for the initial release

**Rationale**: The feature needs durable background processing but does not require separate infrastructure. A dedicated worker class started by the backend process is enough as long as the queue is durable in PostgreSQL and in-flight jobs are re-queued safely on startup.

**Alternatives considered**:
- Separate standalone worker executable: rejected for the initial release to keep operational rollout simpler.
- Trigger processing only from HTTP requests: rejected because queued work could stall indefinitely without new traffic.

## Decision: Re-queue or reclaim in-flight jobs on startup

**Rationale**: A process can die after claiming work. On startup, the worker must make previously claimed but unfinished jobs eligible again so accepted work is not stranded in `processing`.

**Alternatives considered**:
- Leave in-flight jobs untouched: rejected because a crash would permanently orphan work until manual intervention.
- Use heartbeat renewal immediately: rejected for the initial release as unnecessary complexity.

## Decision: Frontend will poll for non-final document status

**Rationale**: Polling satisfies the approved scope and keeps the frontend change focused. It also works with the existing request model and does not require adding streaming infrastructure.

**Alternatives considered**:
- WebSocket or SSE status streaming: rejected for the initial release because it increases scope and is not required by the spec.

## Decision: Add an explicit reprocess action for failed documents

**Rationale**: The spec requires a user-visible recovery path for terminal failures. A reprocess action lets operators retry failed documents without editing content or touching the database.

**Alternatives considered**:
- Require editing and saving the document again: rejected because it hides the recovery path and does not make retry intent obvious in the UI.
