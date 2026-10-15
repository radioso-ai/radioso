-- Durable background work the worker runs: one row per job, claimed under a lease and deleted
-- once it completes, because a payload can carry conversation identifiers or content. Postgres
-- owns the job state; a Cloud Task or the worker's poll loop only wakes a worker to look. A job
-- that keeps failing is dead-lettered with its last error and removed by a retention sweep.
CREATE TABLE background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
  payload JSONB NOT NULL,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'dead')),
  -- Runs started, counting the current one. Every write back from a run is fenced on it, so a
  -- worker whose lease expired cannot complete or fail a newer claim of the same job.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  dead_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT background_jobs_running_has_lease CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT background_jobs_dead_has_dead_at CHECK ((status = 'dead') = (dead_at IS NOT NULL))
);

-- One live job per kind and key: an enqueue while a job with the same key waits or runs adds
-- nothing. Dead-lettered rows (the only ones with `dead_at`) fall out of the index, so a failed
-- job never blocks later work for the same key. The predicate takes no parameters, so an
-- `ON CONFLICT ... WHERE` arbiter can always be matched to it.
CREATE UNIQUE INDEX background_jobs_live_idempotency_key_uniq
  ON background_jobs (kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND dead_at IS NULL;

CREATE INDEX background_jobs_pending_available_at_idx ON background_jobs (available_at) WHERE status = 'pending';
CREATE INDEX background_jobs_running_lease_expires_at_idx ON background_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX background_jobs_dead_at_idx ON background_jobs (dead_at) WHERE status = 'dead';
