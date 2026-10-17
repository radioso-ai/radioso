-- Durable background work the worker runs: one row per job, claimed under a lease and deleted
-- once it completes, because a payload can carry conversation identifiers or content. Postgres
-- owns the job state; a Cloud Task or the worker's poll loop only wakes a worker to look. A job
-- that keeps failing is dead-lettered: its payload is dropped in the same write, it keeps an
-- operator-safe error summary, and a retention sweep removes it.
CREATE TABLE background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 128),
  -- Null only once dead-lettered: the payload can carry customer content, and a dead letter is kept
  -- for inspection by its kind, key, attempts, and error.
  payload JSONB,
  idempotency_key TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'dead')),
  -- Runs started since the job last completed, counting the current one.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_expires_at TIMESTAMPTZ,
  -- Unique to each claim. Every write back from a run is fenced on it, so a worker whose lease was
  -- taken over cannot renew, complete, retry, or dead-letter the newer claim.
  claim_token UUID,
  -- Set when an enqueue for a level-triggered kind finds the job running: the run may have read
  -- state older than that enqueue's change, so completion returns the job to waiting.
  rerun_requested BOOLEAN NOT NULL DEFAULT false,
  -- The error's class and an application error code, never its message: a message can carry
  -- conversation text, provider responses, or credentials.
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 160),
  dead_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT background_jobs_running_has_lease CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT background_jobs_running_has_claim_token CHECK ((status = 'running') = (claim_token IS NOT NULL)),
  CONSTRAINT background_jobs_rerun_only_while_running CHECK (NOT rerun_requested OR status = 'running'),
  CONSTRAINT background_jobs_dead_has_dead_at CHECK ((status = 'dead') = (dead_at IS NOT NULL)),
  CONSTRAINT background_jobs_dead_has_no_payload CHECK ((status = 'dead') = (payload IS NULL))
);

-- One live job per kind and key: what a duplicate enqueue does is the kind's choice (folded, or a
-- rerun requested). Dead-lettered rows (the only ones with `dead_at`) fall out of the index, so a
-- failed job never blocks later work for the same key. The predicate takes no parameters, so an
-- `ON CONFLICT ... WHERE` arbiter can always be matched to it.
CREATE UNIQUE INDEX background_jobs_live_idempotency_key_uniq
  ON background_jobs (kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND dead_at IS NULL;

CREATE INDEX background_jobs_pending_available_at_idx ON background_jobs (available_at) WHERE status = 'pending';
CREATE INDEX background_jobs_running_lease_expires_at_idx ON background_jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX background_jobs_dead_at_idx ON background_jobs (dead_at) WHERE status = 'dead';
