-- Migration 181 disables a lineage's canonical (highest-version) row whenever it is not
-- published, but every read in this branch's collapsed model — `canonicalLineageRow` /
-- `canonicalRowForId` in routineDefinitionRepository.ts, `selectCanonicalRoutineDefinitions` in
-- draftProjection.ts — only ever looks at that single top row. For a lineage shaped like
-- v1 superseded / v2 published (content that was actually serving traffic) / v3 draft (an
-- "Edit revision" started pre-cutover and abandoned), 181 correctly disables v3, but v3 stays
-- canonical: the routine goes permanently dark and v2's content becomes unaddressable, even
-- though it was live a moment before this deploys.
--
-- Non-destructive fix, matching this repo's migration philosophy for this table (nothing
-- dropped, merged, or overwritten): for every lineage whose canonical row just came out of
-- service this way, clone the lineage's most recently published row's full content — routine
-- columns plus every child table (routine_slot/routine_step/routine_transition/routine_terminal/
-- routine_completion_export) — into a brand new row on top of the lineage: version = MAX+1,
-- status = 'published', enabled = TRUE. Canonical-row selection then naturally recovers the
-- content that was actually serving, while the abandoned draft stays exactly where 181 left it:
-- disabled, in history, harmless. A lineage with no published row anywhere beneath its disabled
-- canonical row (pure never-published draft) has nothing to promote and is left as 181 backfilled
-- it — simply disabled.
--
-- Idempotent by construction: once a lineage is promoted, its canonical row is the new published
-- copy, so the WHERE clause below (canonical row not published) no longer selects it on a re-run.
DO $$
DECLARE
  lineage RECORD;
  source RECORD;
  new_id UUID;
  new_version INTEGER;
  promoted_count INTEGER := 0;
BEGIN
  IF to_regclass('public.routine_definition') IS NULL THEN
    RETURN;
  END IF;

  FOR lineage IN
    SELECT DISTINCT d.lineage_id
    FROM routine_definition d
    WHERE d.status != 'published'
      AND d.version = (SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id)
  LOOP
    -- The partial unique index one_published_per_lineage guarantees at most one 'published' row
    -- per lineage historically; ORDER BY/LIMIT is a defensive no-op, not load-bearing.
    SELECT * INTO source
    FROM routine_definition
    WHERE lineage_id = lineage.lineage_id AND status = 'published'
    ORDER BY version DESC
    LIMIT 1;

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    new_id := gen_random_uuid();
    SELECT MAX(version) + 1 INTO new_version FROM routine_definition WHERE lineage_id = lineage.lineage_id;

    -- idx_routine_definition_one_published_per_lineage allows at most one 'published' row per
    -- lineage, so the new row below cannot be inserted as 'published' while the source row still
    -- holds that status. The source row's content is about to get a live successor, which is
    -- exactly what 'superseded' already means for every other row in this table's history — flip
    -- it first so the index stays satisfiable and the source row reads exactly like any other
    -- superseded version from here on. Its content is untouched; only this one column changes.
    UPDATE routine_definition SET status = 'superseded' WHERE id = source.id;

    INSERT INTO routine_definition (
      id, agent_id, lineage_id, version, name, status, enabled,
      activation_trigger_description, activation_gate_ref, activation_priority,
      activation_reentry_mode, activation_coverage_criteria,
      trigger_embedding, trigger_embedding_model, trigger_embedding_hash
    )
    SELECT
      new_id, agent_id, lineage_id, new_version, name, 'published', TRUE,
      activation_trigger_description, activation_gate_ref, activation_priority,
      activation_reentry_mode, activation_coverage_criteria,
      trigger_embedding, trigger_embedding_model, trigger_embedding_hash
    FROM routine_definition
    WHERE id = source.id;

    INSERT INTO routine_slot (definition_id, stable_slot_id, key, type, required, description, ordinal, mutable)
    SELECT new_id, stable_slot_id, key, type, required, description, ordinal, mutable
    FROM routine_slot WHERE definition_id = source.id;

    INSERT INTO routine_step (definition_id, stable_step_id, kind, instruction, tool_ref, ordinal, metadata, action_type, capture_key, options)
    SELECT new_id, stable_step_id, kind, instruction, tool_ref, ordinal, metadata, action_type, capture_key, options
    FROM routine_step WHERE definition_id = source.id;

    INSERT INTO routine_terminal (definition_id, stable_step_id, kind, instruction, action_type, ordinal)
    SELECT new_id, stable_step_id, kind, instruction, action_type, ordinal
    FROM routine_terminal WHERE definition_id = source.id;

    INSERT INTO routine_transition (
      definition_id, from_step, to_ref, guard_kind, guard_text, ordinal, outcome_status,
      counter_limit, field_ref, field_op, field_value, field_values, field_unit
    )
    SELECT
      new_id, from_step, to_ref, guard_kind, guard_text, ordinal, outcome_status,
      counter_limit, field_ref, field_op, field_value, field_values, field_unit
    FROM routine_transition WHERE definition_id = source.id;

    INSERT INTO routine_completion_export (definition_id, enabled, trigger_kinds, destination_ref)
    SELECT new_id, enabled, trigger_kinds, destination_ref
    FROM routine_completion_export WHERE definition_id = source.id;

    promoted_count := promoted_count + 1;
  END LOOP;

  -- Support/debug correlation: the number of lineages this run actually recovered content for,
  -- distinguishing "nothing to do" from "recovered N routines" without exposing any routine
  -- content, name, or workspace identity.
  RAISE NOTICE '183: promoted % stranded lineage(s) to a new published canonical row', promoted_count;
END $$;
