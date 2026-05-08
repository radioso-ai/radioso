CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  retrieval_enabled BOOLEAN NOT NULL DEFAULT true,
  behavior_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  greeting_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_modes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_anonymous_chat_token_unique
  ON agents ((output_modes #>> '{anonymousChat,token}'))
  WHERE (output_modes #>> '{anonymousChat,token}') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_website_embed_token_unique
  ON agents ((output_modes #>> '{websiteEmbed,token}'))
  WHERE (output_modes #>> '{websiteEmbed,token}') IS NOT NULL;

ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS default_agent_id UUID;

INSERT INTO agents (
  id,
  workspace_id,
  name,
  retrieval_enabled,
  behavior_settings,
  greeting_settings,
  output_modes,
  created_at,
  updated_at
)
SELECT
  COALESCE(w.default_agent_id, gen_random_uuid()),
  w.id,
  COALESCE(NULLIF(w.assistant_name, ''), w.name, 'Agent'),
  true,
  jsonb_build_object(
    'customInstruction', COALESCE(rs.custom_instruction, ''),
    'conversationMode', COALESCE(rs.attribute_controls ->> 'conversationMode', 'guided'),
    'suggestedQuestionsEnabled', COALESCE((rs.attribute_controls ->> 'suggestedQuestionsEnabled')::boolean, true),
    'suggestedQuestionsCount', COALESCE((rs.attribute_controls ->> 'suggestedQuestionsCount')::integer, 3)
  ),
  jsonb_build_object(
    'greetingInstruction', COALESCE(w.greeting_instruction, ''),
    'assistantDefaultLocale', w.assistant_default_locale,
    'proactiveGreetingEnabled', COALESCE(w.proactive_greeting_enabled, false)
  ),
  jsonb_build_object(
    'authenticatedChat', jsonb_build_object(
      'enabled', true
    ),
    'anonymousChat', jsonb_build_object(
      'enabled', COALESCE(w.anonymous_chat_enabled, false),
      'token', w.anonymous_chat_token,
      'messagesPerMinute', COALESCE(w.anonymous_rate_limit, 10)
    ),
    'websiteEmbed', jsonb_build_object(
      'enabled', COALESCE(w.website_embed_enabled, false),
      'token', w.website_embed_token,
      'allowedOrigins', COALESCE(to_jsonb(w.website_embed_allowed_origins), '[]'::jsonb),
      'launcherLabel', COALESCE(w.website_embed_launcher_label, 'Chat with us'),
      'icon', COALESCE(w.website_embed_launcher_icon, 'chat'),
      'launcherPosition', COALESCE(w.website_embed_launcher_position, 'bottom-right')
    )
  ),
  w.created_at,
  w.updated_at
FROM workspaces w
LEFT JOIN retrieval_settings rs ON rs.workspace_id = w.id
WHERE NOT EXISTS (
  SELECT 1 FROM agents a WHERE a.workspace_id = w.id
);

UPDATE workspaces w
SET default_agent_id = a.id
FROM (
  SELECT DISTINCT ON (workspace_id) id, workspace_id
  FROM agents
  ORDER BY workspace_id, created_at ASC, id ASC
) a
WHERE a.workspace_id = w.id
  AND w.default_agent_id IS NULL;

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS agent_id UUID;

UPDATE conversations c
SET agent_id = w.default_agent_id
FROM workspaces w
WHERE c.workspace_id = w.id
  AND c.agent_id IS NULL
  AND w.default_agent_id IS NOT NULL;

ALTER TABLE bootstrap_greeting_cache
ADD COLUMN IF NOT EXISTS agent_id UUID;

UPDATE bootstrap_greeting_cache bgc
SET agent_id = w.default_agent_id
FROM workspaces w
WHERE bgc.workspace_id = w.id
  AND bgc.agent_id IS NULL
  AND w.default_agent_id IS NOT NULL;

ALTER TABLE bootstrap_greeting_cache
ALTER COLUMN agent_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspaces_default_agent_id_fkey'
  ) THEN
    ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_default_agent_id_fkey
    FOREIGN KEY (default_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_agent_id_fkey'
  ) THEN
    ALTER TABLE conversations
    ADD CONSTRAINT conversations_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bootstrap_greeting_cache_agent_id_fkey'
  ) THEN
    ALTER TABLE bootstrap_greeting_cache
    ADD CONSTRAINT bootstrap_greeting_cache_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bootstrap_greeting_cache_workspace_id_fingerprint_key'
  ) THEN
    ALTER TABLE bootstrap_greeting_cache
    DROP CONSTRAINT bootstrap_greeting_cache_workspace_id_fingerprint_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bootstrap_greeting_cache_workspace_agent_fingerprint_key'
  ) THEN
    ALTER TABLE bootstrap_greeting_cache
    ADD CONSTRAINT bootstrap_greeting_cache_workspace_agent_fingerprint_key
    UNIQUE (workspace_id, agent_id, fingerprint);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_workspace_agent_updated_id
  ON conversations (workspace_id, agent_id, updated_at DESC, created_at DESC, id DESC);
