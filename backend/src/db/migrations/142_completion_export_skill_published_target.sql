DO $$
BEGIN
  -- Production migrations record applied files before this forward correction runs. The
  -- schema-snapshot harness applies raw SQL without that metadata table, where there is no
  -- historic 111 projection to repair.
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $correction$
    -- Migration 111 records its application after it projects agent_skills. A row untouched
    -- since then is the only safe candidate for this correction; later skill edits are operator
    -- intent and must win over the historical routine-derived value.
    WITH migration_111 AS (
      SELECT applied_at
      FROM schema_migrations
      WHERE filename = '111_notify_and_completion_export_skills.sql'
    ),
    ranked_exports AS (
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
    JOIN migration_111 ON TRUE
    WHERE skill.agent_id = ranked_exports.agent_id
      AND skill.skill_name = 'completion_export'
      AND skill.kind = 'webhook'
      AND skill.target_type = 'webhook_destination'
      AND skill.invocation_mode = 'routine_named'
      AND skill.updated_at <= migration_111.applied_at
  $correction$;
END $$;
