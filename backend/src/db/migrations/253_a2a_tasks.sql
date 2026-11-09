-- A2A tasks and message receipts: the bookkeeping the A2A JSON-RPC binding keeps beside a
-- conversation (spec a2a-protocol-binding, FR-031 and FR-038).
--
-- A task is references and state only: the conversation it belongs to, the context id the calling
-- agent holds (sealed with the field encryption keys, so it reads as nothing here), the routine run
-- it follows, message ids, an opaque conversation cursor, its state, and a version a write
-- compares and sets. It never copies message content. `human_stretch` records, once and for good,
-- that a person owned the thread or wrote in it while the task was open; `reason` says only what
-- last moved the task. The partial unique index keeps one open task per conversation, as the engine
-- keeps one thread and one routine state per conversation.
--
-- A receipt makes SendMessage idempotent on (conversation, the caller's message id). The caller's
-- id is kept as a digest. An in-flight receipt answers a retry while the first send still runs, and
-- carries a random claim token: only the send holding it completes or releases it, so a send whose
-- stale claim was taken over changes nothing. A completed receipt carries what replays the original
-- result: the reply's message id and the turn's report, or the task's id.
--
-- Both follow their conversation (deleting it, by erasure or retention, deletes their rows) and
-- their workspace. Expired walk-in contexts and old terminal tasks are pruned by the conversation
-- retention sweep's own rules.
--
-- Locks: two new tables, whose foreign keys take SHARE ROW EXCLUSIVE on workspaces and
-- conversations for the instant each is created. The wait is bounded; a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE a2a_tasks (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 128),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  context_token TEXT NOT NULL,
  context_expires_at TIMESTAMPTZ,
  routine_execution_id TEXT,
  opening_message_id UUID,
  caller_message_id UUID,
  cursor TEXT,
  shown_through_message_id UUID,
  status_message_id UUID,
  artifact_message_id UUID,
  envelope JSONB,
  state TEXT NOT NULL CHECK (state IN (
    'submitted',
    'working',
    'input_required',
    'auth_required',
    'completed',
    'failed',
    'canceled',
    'rejected'
  )),
  reason TEXT,
  human_stretch BOOLEAN NOT NULL DEFAULT false,
  state_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open task per conversation.
CREATE UNIQUE INDEX a2a_tasks_one_open_per_conversation
  ON a2a_tasks (conversation_id)
  WHERE state IN ('submitted', 'working', 'input_required', 'auth_required');

-- ListTasks: one context's tasks, newest status first.
CREATE INDEX a2a_tasks_conversation_state_at_idx
  ON a2a_tasks (conversation_id, state_at DESC, id DESC);

-- Retention: walk-in contexts past their end.
CREATE INDEX a2a_tasks_context_expires_at_idx
  ON a2a_tasks (context_expires_at)
  WHERE context_expires_at IS NOT NULL;

CREATE TABLE a2a_message_receipts (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_digest TEXT NOT NULL CHECK (length(message_digest) BETWEEN 16 AND 128),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('in_flight', 'completed')),
  claim_token TEXT,
  result JSONB,
  claimed_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, message_digest),
  CHECK ((state = 'completed') = (result IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state <> 'in_flight' OR claim_token IS NOT NULL)
);

-- Retention: receipts of walk-in contexts past their end.
CREATE INDEX a2a_message_receipts_expires_at_idx
  ON a2a_message_receipts (expires_at)
  WHERE expires_at IS NOT NULL;
