WITH ranked_exports AS (
  SELECT DISTINCT ON (d.agent_id)
    d.agent_id,
    ce.destination_ref
  FROM routine_completion_export ce
  JOIN routine_definition d ON d.id = ce.definition_id
  JOIN agents a ON a.id = d.agent_id
  JOIN workspace_webhook_destinations wd
    ON wd.workspace_id = a.workspace_id
   AND wd.id::text = lower(ce.destination_ref)
  WHERE d.status = 'published'
    AND ce.enabled = TRUE
    AND COALESCE((a.behavior_settings ->> 'webhookExportsEnabled')::boolean, FALSE) = TRUE
    AND NULLIF(BTRIM(ce.destination_ref), '') IS NOT NULL
  ORDER BY d.agent_id, d.updated_at DESC, ce.destination_ref ASC
)
UPDATE agent_skills AS skill
SET target_id = ranked_exports.destination_ref,
    updated_at = NOW()
FROM ranked_exports
WHERE skill.agent_id = ranked_exports.agent_id
  AND skill.skill_name = 'completion_export'
  AND skill.kind = 'webhook'
  AND skill.target_type = 'webhook_destination'
  AND skill.invocation_mode = 'routine_named';
