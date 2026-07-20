-- Per-conversation directive firing memory (issue #865). Directive matching is
-- stateless per turn; this table is what lets `once_per_conversation` and
-- `cooldown` directives be suppressed on later turns. One row per conversation
-- (keyed by the conversation id, the engine's session id).
--
-- `turn_seq` is the count of turns already committed for the conversation and
-- advances exactly once per turn (at turn completion), so it is a stable turn
-- index even when the matcher runs more than once within a turn. `firings` maps a
-- directive name to `{ "lastFiredTurn": <turn_seq>, "count": <n> }`, recording the
-- turn at which the directive last rendered into steering. `expires_at` bounds an
-- abandoned conversation so the memory does not accumulate forever.
CREATE TABLE IF NOT EXISTS directive_states (
  session_id  UUID PRIMARY KEY,
  turn_seq    INTEGER NOT NULL DEFAULT 0,
  firings     JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
