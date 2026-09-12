-- Agent drafts are mutable projections of normalized authoring rows. Migrations 181 and 183
-- changed which historical row is canonical, but must not rewrite released revisions: those are
-- deliberately immutable for live and pinned conversations. Rebuild only draft routines from the
-- current canonical rows, then repoint draft directive scopes to that same row. Incrementing the
-- generation fences candidates frozen against the stale JSON before this migration ran.
WITH canonical_routines AS (
  SELECT DISTINCT ON (lineage_id) *
  FROM routine_definition
  ORDER BY lineage_id, version DESC
), routine_json AS (
  SELECT r.id, r.agent_id, r.lineage_id, r.version, r.activation_priority, r.created_at,
    jsonb_build_object(
      'id', r.id, 'agentId', r.agent_id, 'lineageId', r.lineage_id, 'version', r.version,
      'enabled', r.enabled, 'name', r.name,
      'activation', jsonb_build_object(
        'triggerDescription', r.activation_trigger_description, 'gateRef', r.activation_gate_ref,
        'priority', r.activation_priority, 'reentryMode', r.activation_reentry_mode
      ) || CASE WHEN r.activation_coverage_criteria IS NULL THEN '{}'::jsonb
               ELSE jsonb_build_object('coverageCriteria', r.activation_coverage_criteria) END,
      'slots', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'stableSlotId', s.stable_slot_id, 'key', s.key, 'type', s.type, 'required', s.required,
        'description', s.description, 'mutable', s.mutable, 'ordinal', s.ordinal
      ) ORDER BY s.ordinal) FROM routine_slot s WHERE s.definition_id = r.id), '[]'::jsonb),
      'steps', coalesce((SELECT jsonb_agg(
        jsonb_build_object(
          'stableStepId', s.stable_step_id, 'kind', CASE WHEN s.kind = 'fork' THEN 'chat' ELSE s.kind END, 'instruction', s.instruction,
          'toolRef', s.tool_ref, 'actionType', s.action_type, 'ordinal', s.ordinal, 'metadata', s.metadata
        ) || CASE WHEN s.capture_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('captureKey', s.capture_key) END
          || CASE WHEN s.options IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('options', s.options) END
        ORDER BY s.ordinal
      ) FROM routine_step s WHERE s.definition_id = r.id), '[]'::jsonb),
      'transitions', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'fromStep', t.from_step, 'toRef', t.to_ref, 'guardKind', CASE WHEN t.guard_kind IN ('always', 'fallback') THEN 'default' ELSE t.guard_kind END, 'guardText', t.guard_text,
        'outcomeStatus', t.outcome_status, 'counterLimit', t.counter_limit, 'fieldRef', t.field_ref,
        'fieldOp', t.field_op, 'fieldValue', t.field_value, 'fieldValues', t.field_values,
        'fieldUnit', t.field_unit, 'ordinal', t.ordinal
      ) ORDER BY t.ordinal) FROM routine_transition t WHERE t.definition_id = r.id), '[]'::jsonb),
      'terminals', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'stableStepId', t.stable_step_id, 'kind', t.kind, 'instruction', t.instruction, 'ordinal', t.ordinal
      ) ORDER BY t.ordinal) FROM routine_terminal t WHERE t.definition_id = r.id), '[]'::jsonb),
      'completionExport', coalesce((SELECT jsonb_build_object(
        'enabled', e.enabled, 'triggerKinds', e.trigger_kinds, 'destinationRef', e.destination_ref
      ) FROM routine_completion_export e WHERE e.definition_id = r.id),
      jsonb_build_object('enabled', false, 'triggerKinds', '[]'::jsonb, 'destinationRef', '')),
      'createdAt', r.created_at, 'updatedAt', r.updated_at
    ) AS routine
  FROM canonical_routines r
), repaired AS (
  SELECT draft.agent_id,
    jsonb_set(
      jsonb_set(
        draft.snapshot,
        '{routines}',
        coalesce((SELECT jsonb_agg(routine ORDER BY activation_priority DESC, created_at, id)
          FROM routine_json WHERE agent_id = draft.agent_id), '[]'::jsonb)
      ),
      '{directives}',
      coalesce((SELECT jsonb_agg(repointed.directive ORDER BY original.ordinal)
        FROM jsonb_array_elements(draft.snapshot -> 'directives') WITH ORDINALITY AS original(directive, ordinal)
        CROSS JOIN LATERAL (
          SELECT jsonb_set(original.directive, '{tags}', coalesce((
            SELECT jsonb_agg(to_jsonb(CASE
              WHEN source.lineage_id IS NULL OR target.id IS NULL OR source.id = target.id THEN tag.value
              WHEN tag.value ~ '^routine:[0-9A-Fa-f-]{36}$' THEN 'routine:' || target.id::text
              WHEN tag.value ~ '^step:[0-9A-Fa-f-]{36}:.+$'
                AND EXISTS (SELECT 1 FROM routine_step step WHERE step.definition_id = target.id
                  AND step.stable_step_id = substring(tag.value FROM '^step:[0-9A-Fa-f-]{36}:(.+)$'))
                THEN 'step:' || target.id::text || ':' || substring(tag.value FROM '^step:[0-9A-Fa-f-]{36}:(.+)$')
              ELSE tag.value
            END) ORDER BY tag.ordinal)
            FROM jsonb_array_elements_text(coalesce(original.directive -> 'tags', '[]'::jsonb)) WITH ORDINALITY AS tag(value, ordinal)
            LEFT JOIN LATERAL (
              SELECT source.id, source.lineage_id FROM routine_definition source
              WHERE source.agent_id = draft.agent_id AND source.id::text = lower(CASE
                WHEN tag.value ~ '^routine:[0-9A-Fa-f-]{36}$' THEN substring(tag.value FROM '^routine:([0-9A-Fa-f-]{36})$')
                WHEN tag.value ~ '^step:[0-9A-Fa-f-]{36}:.+$' THEN substring(tag.value FROM '^step:([0-9A-Fa-f-]{36}):.+$')
              END)
            ) source ON TRUE
            LEFT JOIN canonical_routines target ON target.lineage_id = source.lineage_id
          ), '[]'::jsonb)) AS directive
        ) AS repointed
      ), '[]'::jsonb),
      true
    ) AS snapshot
  FROM agent_drafts draft
)
UPDATE agent_drafts draft
SET snapshot = repaired.snapshot, generation = draft.generation + 1, updated_at = now()
FROM repaired
WHERE draft.agent_id = repaired.agent_id
  AND draft.snapshot IS DISTINCT FROM repaired.snapshot;
