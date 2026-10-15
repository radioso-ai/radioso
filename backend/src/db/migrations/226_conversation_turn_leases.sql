-- Cross-instance coordination of chat turns (#1505). Every process that runs a conversation's turns
-- orders them through these rows, so a newer message or a caller speaking over the agent supersedes
-- the turn in flight even when another instance runs it. Notifications on the
-- `radioso_conversation_turns` channel only wake the processes involved; these rows are the truth.

CREATE SEQUENCE conversation_turn_id_seq;

-- One row per turn in flight, owned by the process that runs it. The owner renews
-- `lease_expires_at` while the turn runs and the lease is still live; expiry is final. A successor
-- stops waiting for a turn whose lease expired (its process crashed or stalled) and waits for that
-- turn's own predecessor instead. Deleted when the turn completes, or pruned a while after expiry.
CREATE TABLE conversation_turn_leases (
  turn_id BIGINT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  -- The conversation's previous turn, when it was still in flight as this one started.
  predecessor_turn_id BIGINT,
  owner_instance_id TEXT NOT NULL CHECK (length(owner_instance_id) BETWEEN 1 AND 128),
  supersede_after_emission BOOLEAN NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pruning finds leases long expired; catching up after a missed notice finds the turns started
-- right behind a process's own.
CREATE INDEX conversation_turn_leases_lease_expires_at_idx ON conversation_turn_leases (lease_expires_at);
CREATE INDEX conversation_turn_leases_predecessor_turn_id_idx ON conversation_turn_leases (predecessor_turn_id);

-- One row per conversation whose latest turn is in flight: the serialization point a starting turn
-- locks to take its place after that latest turn. Deleted when that latest turn completes.
CREATE TABLE conversation_turn_heads (
  conversation_id TEXT PRIMARY KEY,
  turn_id BIGINT NOT NULL,
  predecessor_turn_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
