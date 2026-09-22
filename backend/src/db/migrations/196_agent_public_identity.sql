-- The public id keys an agent's discovery cards, its credential-free walk-in exchange, and the
-- link the embed emits. That makes it agent-level identity rather than a fact about one surface,
-- so it is a column and not a key under `output_modes`; it is also the lookup key on two
-- unauthenticated hot paths, where a b-tree unique index beats an expression index over a JSON
-- path. `internal_name` set the precedent for a scalar agent-level fact living in a column.
--
-- Nullable because the id is minted the first time an operator publishes the agent, not when the
-- agent is created. The partial unique index therefore admits any number of unminted agents while
-- keeping every minted id distinct.
--
-- `public_agent_access_enabled` opens the credential-free door; `agent_card_enabled` publishes the
-- cards. They are separate because an agent that needs a credential still benefits from a card
-- that says so. The domain holds the invariant that walk-in implies a card.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS public_id TEXT,
  ADD COLUMN IF NOT EXISTS public_description TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agent_card_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS public_agent_access_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS walk_in_conversations_per_hour INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS agents_public_id_key
  ON agents (public_id)
  WHERE public_id IS NOT NULL;
