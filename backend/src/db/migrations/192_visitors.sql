-- Visitors entity, request-facts columns, and the identity-resolution CHECK
-- widening (spec 1277, FR-001/002/010/030). A visitor is a workspace-scoped
-- person as far as Radioso can tell: keyed by a durable anonymous session id
-- and/or a host-verified customer id, with first/last seen, a conversation
-- count, and the latest observed country/language/user agent. Chat services
-- resolve one per new conversation (backend/src/modules/visitors/); the
-- entity replaces a derived query over the two string columns conversations
-- already carried.

CREATE TABLE IF NOT EXISTS visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  anonymous_session_id TEXT NULL,
  verified_customer_id TEXT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_count INTEGER NOT NULL DEFAULT 0,
  last_country TEXT NULL,
  last_language TEXT NULL,
  last_user_agent TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per anonymous id / verified id within a workspace. Partial so a
-- visitor known by only one of the two keys never collides on the other's
-- (workspace, NULL) pair, and so `INSERT ... ON CONFLICT (...) WHERE ...`
-- in the repository has a matching conflict target for each key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_workspace_anonymous_session
  ON visitors (workspace_id, anonymous_session_id)
  WHERE anonymous_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_workspace_verified_customer
  ON visitors (workspace_id, verified_customer_id)
  WHERE verified_customer_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS visitor_id UUID NULL REFERENCES visitors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS request_context JSONB NULL,
  ADD COLUMN IF NOT EXISTS entry_referrer TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id ON conversations (visitor_id);

-- Backfill (FR-002): only `purpose = 'production'` conversations participate
-- (operator-test transcripts never get a visitor, matching FR-005 for new
-- conversations). first/last seen and conversation_count derive from created_at.
--
-- "Not already covered by a conversation that has a verified id" is a
-- workspace+anonymous-id-level fact, not a per-row one: a shopper who chatted
-- anonymously twice before verifying on a third conversation must backfill as
-- one verified visitor with all three conversations, not a stranded
-- anonymous-only visitor plus a separate verified one. This map captures,
-- for every anonymous id that ever shared a conversation with a verified id,
-- which verified id it resolves to (one arbitrary match — by construction the
-- live resolver never lets one anonymous id carry two, but historical rows
-- predate that rule, so `DISTINCT ON` picks the earliest deterministically).
CREATE TEMPORARY TABLE _visitor_backfill_anon_verified_map ON COMMIT DROP AS
SELECT DISTINCT ON (workspace_id, anonymous_session_id)
  workspace_id, anonymous_session_id, verified_customer_id
FROM conversations
WHERE purpose = 'production' AND anonymous_session_id IS NOT NULL AND verified_customer_id IS NOT NULL
ORDER BY workspace_id, anonymous_session_id, created_at;

INSERT INTO visitors (workspace_id, verified_customer_id, first_seen_at, last_seen_at, conversation_count)
SELECT workspace_id, verified_customer_id, MIN(created_at), MAX(created_at), COUNT(*)
FROM (
  SELECT c.workspace_id, c.verified_customer_id, c.created_at
  FROM conversations c
  WHERE c.purpose = 'production' AND c.verified_customer_id IS NOT NULL
  UNION ALL
  SELECT c.workspace_id, m.verified_customer_id, c.created_at
  FROM conversations c
  JOIN _visitor_backfill_anon_verified_map m
    ON m.workspace_id = c.workspace_id AND m.anonymous_session_id = c.anonymous_session_id
  WHERE c.purpose = 'production' AND c.verified_customer_id IS NULL AND c.anonymous_session_id IS NOT NULL
) verified_conversations
GROUP BY workspace_id, verified_customer_id;

INSERT INTO visitors (workspace_id, anonymous_session_id, first_seen_at, last_seen_at, conversation_count)
SELECT c.workspace_id, c.anonymous_session_id, MIN(c.created_at), MAX(c.created_at), COUNT(*)
FROM conversations c
LEFT JOIN _visitor_backfill_anon_verified_map m
  ON m.workspace_id = c.workspace_id AND m.anonymous_session_id = c.anonymous_session_id
WHERE c.purpose = 'production'
  AND c.anonymous_session_id IS NOT NULL
  AND c.verified_customer_id IS NULL
  AND m.anonymous_session_id IS NULL
GROUP BY c.workspace_id, c.anonymous_session_id;

-- Conversations that carry a verified id directly.
UPDATE conversations c
SET visitor_id = v.id
FROM visitors v
WHERE c.purpose = 'production'
  AND c.verified_customer_id IS NOT NULL
  AND v.workspace_id = c.workspace_id
  AND v.verified_customer_id = c.verified_customer_id;

-- Anonymous-only conversations whose anonymous id maps to a verified visitor.
UPDATE conversations c
SET visitor_id = v.id
FROM _visitor_backfill_anon_verified_map m
JOIN visitors v ON v.workspace_id = m.workspace_id AND v.verified_customer_id = m.verified_customer_id
WHERE c.purpose = 'production'
  AND c.visitor_id IS NULL
  AND c.anonymous_session_id IS NOT NULL
  AND c.verified_customer_id IS NULL
  AND m.workspace_id = c.workspace_id
  AND m.anonymous_session_id = c.anonymous_session_id;

-- Remaining anonymous-only conversations: link to their own anonymous-keyed visitor.
UPDATE conversations c
SET visitor_id = v.id
FROM visitors v
WHERE c.purpose = 'production'
  AND c.visitor_id IS NULL
  AND c.anonymous_session_id IS NOT NULL
  AND v.workspace_id = c.workspace_id
  AND v.anonymous_session_id = c.anonymous_session_id
  AND v.verified_customer_id IS NULL;

-- FR-030: the built-in `visitor_request` context variable resolves through
-- source 'request' (request-derived facts), joining the three sources this
-- CHECK already allowed.
ALTER TABLE agent_context_variables
  DROP CONSTRAINT agent_context_variables_source_check,
  ADD CONSTRAINT agent_context_variables_source_check CHECK (source IN ('pushed', 'browser', 'resolver', 'request'));
