INSERT INTO agent_skills (
  id, workspace_id, agent_id, skill_name, kind, target_type, target_id,
  config, invocation_mode, enabled
)
SELECT
  gen_random_uuid(),
  a.workspace_id,
  a.id,
  'contact_human',
  'notify',
  'notify_delivery',
  NULL,
  jsonb_build_object(
    'delivery', COALESCE(a.behavior_settings -> 'contactRequestDelivery', '{"recipientEmails":[],"webhook":null}'::jsonb),
    'exposedInputs', jsonb_build_object('message', TRUE, 'email', TRUE)
  ),
  'routine_named',
  COALESCE((a.behavior_settings ->> 'contactRequestsEnabled')::boolean, FALSE)
FROM agents a
WHERE COALESCE((a.behavior_settings ->> 'contactRequestsEnabled')::boolean, FALSE) = TRUE
ON CONFLICT (agent_id, skill_name)
DO UPDATE SET
  kind = 'notify',
  target_type = 'notify_delivery',
  target_id = NULL,
  config = EXCLUDED.config,
  invocation_mode = 'routine_named',
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

WITH ranked_exports AS (
  SELECT DISTINCT ON (d.agent_id)
    d.agent_id,
    a.workspace_id,
    ce.destination_ref
  FROM routine_completion_export ce
  JOIN routine_definition d ON d.id = ce.definition_id
  JOIN agents a ON a.id = d.agent_id
  JOIN workspace_webhook_destinations wd
    ON wd.workspace_id = a.workspace_id
   AND wd.id::text = lower(ce.destination_ref)
  WHERE ce.enabled = TRUE
    AND COALESCE((a.behavior_settings ->> 'webhookExportsEnabled')::boolean, FALSE) = TRUE
    AND NULLIF(BTRIM(ce.destination_ref), '') IS NOT NULL
  ORDER BY d.agent_id, d.updated_at DESC, ce.destination_ref ASC
)
INSERT INTO agent_skills (
  id, workspace_id, agent_id, skill_name, kind, target_type, target_id,
  config, invocation_mode, enabled
)
SELECT
  gen_random_uuid(),
  workspace_id,
  agent_id,
  'completion_export',
  'webhook',
  'webhook_destination',
  destination_ref,
  jsonb_build_object('boundPayload', '{}'::jsonb, 'exposedPayload', '{}'::jsonb),
  'routine_named',
  TRUE
FROM ranked_exports
ON CONFLICT (agent_id, skill_name)
DO UPDATE SET
  kind = 'webhook',
  target_type = 'webhook_destination',
  target_id = EXCLUDED.target_id,
  config = EXCLUDED.config,
  invocation_mode = 'routine_named',
  enabled = TRUE,
  updated_at = NOW();
