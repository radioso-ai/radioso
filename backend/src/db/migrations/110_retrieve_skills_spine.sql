WITH agent_retrieval AS (
  SELECT
    a.id AS agent_id,
    a.workspace_id,
    COALESCE(a.retrieval_enabled, TRUE) AS retrieval_enabled,
    CASE
      WHEN a.source_scope_mode = 'selected' THEN jsonb_build_object(
        'sourceIds',
        COALESCE(
          (
            SELECT jsonb_agg(COALESCE(ads.source_id::text, '00000000-0000-0000-0000-000000000001') ORDER BY ads.source_id IS NOT NULL, ads.source_id::text)
            FROM agent_document_sources ads
            WHERE ads.agent_id = a.id
          ),
          '[]'::jsonb
        )
      )
      ELSE '"all"'::jsonb
    END AS source_scope,
    COALESCE(a.behavior_settings, '{}'::jsonb) AS behavior_settings,
    CASE
      WHEN jsonb_typeof(COALESCE(a.skill_settings, '{}'::jsonb) -> 'retrieval.answer') = 'object'
      THEN COALESCE(a.skill_settings, '{}'::jsonb) -> 'retrieval.answer'
      ELSE '{}'::jsonb
    END AS retrieval_settings
  FROM agents a
),
projected AS (
  SELECT
    agent_id,
    workspace_id,
    retrieval_enabled,
    (
      (retrieval_settings - 'similarityThreshold' - 'customInstruction')
      || CASE
        WHEN retrieval_settings ? 'customInstruction'
             AND jsonb_typeof(retrieval_settings -> 'customInstruction') = 'string'
        THEN jsonb_build_object('instruction', retrieval_settings -> 'customInstruction')
        ELSE '{}'::jsonb
      END
      || jsonb_build_object(
        'sourceScope', source_scope,
        'suggestedQuestionsEnabled', COALESCE((behavior_settings ->> 'suggestedQuestionsEnabled')::boolean, TRUE),
        'exposedInputs', jsonb_build_object('query', TRUE)
      )
      || CASE
        WHEN behavior_settings ? 'suggestedQuestionsCount'
        THEN jsonb_build_object('suggestedQuestionsCount', (behavior_settings ->> 'suggestedQuestionsCount')::integer)
        ELSE '{}'::jsonb
      END
    ) AS config
  FROM agent_retrieval
)
INSERT INTO agent_skills (
  id,
  workspace_id,
  agent_id,
  skill_name,
  kind,
  target_type,
  target_id,
  config,
  invocation_mode,
  enabled
)
SELECT
  gen_random_uuid(),
  workspace_id,
  agent_id,
  'answer',
  'retrieve',
  'source_scope',
  NULL,
  config,
  'default_answer',
  retrieval_enabled
FROM projected
ON CONFLICT (agent_id, skill_name)
DO UPDATE SET
  kind = 'retrieve',
  target_type = 'source_scope',
  target_id = NULL,
  config = EXCLUDED.config,
  invocation_mode = 'default_answer',
  enabled = EXCLUDED.enabled,
  updated_at = NOW();
