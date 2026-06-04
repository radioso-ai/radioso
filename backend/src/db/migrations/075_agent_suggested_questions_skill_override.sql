WITH agent_suggested_questions AS (
  SELECT
    a.id,
    COALESCE((a.behavior_settings ->> 'suggestedQuestionsEnabled')::boolean, true) AS legacy_enabled,
    COALESCE((rs.attribute_controls ->> 'suggestedQuestionsEnabled')::boolean, true) AS workspace_default_enabled,
    COALESCE(a.skill_settings, '{}'::jsonb) AS skill_settings,
    CASE
      WHEN jsonb_typeof(a.skill_settings -> 'retrieval.answer') = 'object'
      THEN a.skill_settings -> 'retrieval.answer'
      ELSE '{}'::jsonb
    END AS retrieval_answer_settings
  FROM agents a
  LEFT JOIN retrieval_settings rs ON rs.workspace_id = a.workspace_id
)
UPDATE agents a
SET skill_settings = jsonb_set(
    agent_suggested_questions.skill_settings,
    '{retrieval.answer}',
    agent_suggested_questions.retrieval_answer_settings ||
      jsonb_build_object('suggestedQuestionsEnabled', agent_suggested_questions.legacy_enabled),
    true
  ),
  updated_at = NOW()
FROM agent_suggested_questions
WHERE a.id = agent_suggested_questions.id
  AND agent_suggested_questions.legacy_enabled IS DISTINCT FROM agent_suggested_questions.workspace_default_enabled;

WITH agent_suggested_questions AS (
  SELECT
    a.id,
    COALESCE((a.behavior_settings ->> 'suggestedQuestionsEnabled')::boolean, true) AS legacy_enabled,
    COALESCE((rs.attribute_controls ->> 'suggestedQuestionsEnabled')::boolean, true) AS workspace_default_enabled,
    COALESCE(a.skill_settings, '{}'::jsonb) AS skill_settings,
    CASE
      WHEN jsonb_typeof(a.skill_settings -> 'retrieval.answer') = 'object'
      THEN a.skill_settings -> 'retrieval.answer'
      ELSE '{}'::jsonb
    END AS retrieval_answer_settings
  FROM agents a
  LEFT JOIN retrieval_settings rs ON rs.workspace_id = a.workspace_id
)
UPDATE agents a
SET skill_settings = CASE
    WHEN (agent_suggested_questions.retrieval_answer_settings - 'suggestedQuestionsEnabled') = '{}'::jsonb
    THEN agent_suggested_questions.skill_settings - 'retrieval.answer'
    ELSE jsonb_set(
      agent_suggested_questions.skill_settings,
      '{retrieval.answer}',
      agent_suggested_questions.retrieval_answer_settings - 'suggestedQuestionsEnabled',
      true
    )
  END,
  updated_at = NOW()
FROM agent_suggested_questions
WHERE a.id = agent_suggested_questions.id
  AND agent_suggested_questions.legacy_enabled IS NOT DISTINCT FROM agent_suggested_questions.workspace_default_enabled
  AND agent_suggested_questions.retrieval_answer_settings ? 'suggestedQuestionsEnabled';
