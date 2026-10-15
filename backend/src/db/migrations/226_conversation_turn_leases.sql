-- Cross-instance coordination of chat turns (#1505). Every process that runs a conversation's turns
-- orders them through these rows, so a newer message or a caller speaking over the agent supersedes
-- the turn in flight even when another instance runs it. Notifications on the
-- `radioso_conversation_turns` channel only wake the processes involved; these rows are the truth.

-- Turn ids, drawn while the conversation's head row is locked, so a conversation's turn ids grow
-- in the order its turns are placed.
CREATE SEQUENCE conversation_turn_id_seq;

-- One row per turn in flight, owned by the process that runs it. A turn runs once no other
-- process holds a live lease on an older turn of its conversation. The owner renews
-- `lease_expires_at` while the lease is still live; expiry is final, so a crashed or stalled
-- process stops holding newer turns back. Deleted when the turn completes, or pruned a while after
-- expiry.
CREATE TABLE conversation_turn_leases (
  turn_id BIGINT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_instance_id TEXT NOT NULL CHECK (length(owner_instance_id) BETWEEN 1 AND 128),
  supersede_after_emission BOOLEAN NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A waiting turn looks for live leases on older turns of its conversation; pruning finds leases
-- long expired.
CREATE INDEX conversation_turn_leases_conversation_turn_idx ON conversation_turn_leases (conversation_id, turn_id);
CREATE INDEX conversation_turn_leases_lease_expires_at_idx ON conversation_turn_leases (lease_expires_at);

-- One row per conversation whose latest turn is in flight: the lock a starting turn takes to be
-- placed after every turn before it. `previous_turn_id` is the turn it replaced, so a starting
-- turn can tell that a turn placed while it waited for the lock is ahead of it. Deleted when that
-- latest turn completes.
CREATE TABLE conversation_turn_heads (
  conversation_id TEXT PRIMARY KEY,
  turn_id BIGINT NOT NULL,
  previous_turn_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
