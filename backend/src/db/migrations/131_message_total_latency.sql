-- Per-turn total latency as a first-class column on the turn it describes.
--
-- Before this, the quality dashboard derived latency by scanning
-- audit_events.metadata_json for the turn's `chat.answer` event. That is a JSONB
-- scan per listed turn and it makes latency unusable for aggregation. The chat
-- write path now records the value directly.
--
-- Nullable on purpose: user/system messages have no turn latency, and an
-- assistant turn whose trace never produced one stays NULL rather than 0.
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS total_latency_ms INTEGER;

-- One-time historical backfill from the `chat.answer` audit event, latest event wins.
--
-- Source precedence matters, because the two candidates are NOT the same quantity:
--
--   1. activityTrace.stages[stageId='answer'].durationMs -- wall time from answer start
--      to answer completion. This is exactly the value the write path now persists, so
--      backfilled rows and new rows are directly comparable.
--   2. activityTrace.totalDurationMs -- retrieval-pipeline wall time only, and 0 for
--      turns that skipped retrieval. This is what the dashboard read before this change,
--      so it stays as a fallback: older traces predate the answer stage, and dropping it
--      would blank latency the dashboard currently shows for those turns.
--
-- Both candidates are guarded by jsonb_typeof so a missing or non-numeric trace value
-- yields NULL instead of raising on the cast. The CASE around the array walk matters:
-- jsonb_array_elements raises on a non-array argument, so the type test has to gate
-- whether the subquery runs at all, not filter its rows.
UPDATE messages AS m
SET total_latency_ms = (
  SELECT COALESCE(
    CASE
      WHEN jsonb_typeof(e.metadata_json #> '{activityTrace,stages}') = 'array'
        THEN (
          SELECT (stage ->> 'durationMs')::numeric::int
          FROM jsonb_array_elements(e.metadata_json #> '{activityTrace,stages}') AS stage
          WHERE stage ->> 'stageId' = 'answer'
            AND jsonb_typeof(stage -> 'durationMs') = 'number'
          LIMIT 1
        )
      ELSE NULL
    END,
    CASE
      WHEN jsonb_typeof(e.metadata_json #> '{activityTrace,totalDurationMs}') = 'number'
        THEN ((e.metadata_json #>> '{activityTrace,totalDurationMs}')::numeric)::int
      ELSE NULL
    END
  )
  FROM audit_events AS e
  WHERE e.workspace_id = m.workspace_id
    AND e.event_type = 'chat.answer'
    AND e.metadata_json ->> 'assistantMessageId' = m.id::text
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT 1
)
WHERE m.role = 'assistant'
  AND m.total_latency_ms IS NULL
  AND EXISTS (
    SELECT 1
    FROM audit_events AS e
    WHERE e.workspace_id = m.workspace_id
      AND e.event_type = 'chat.answer'
      AND e.metadata_json ->> 'assistantMessageId' = m.id::text
  );

-- No new index. Quality turn queries lead with workspace_id + role + created_at, which
-- migration 069's messages_workspace_role_created_id_idx already covers; latency is a
-- range predicate applied after that scan, so an index carrying it would duplicate an
-- existing key without changing the access path.
