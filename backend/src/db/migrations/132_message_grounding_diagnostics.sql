-- Immutable claim-level grounding snapshot on the assistant message it describes.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS grounding_verdict TEXT,
  ADD COLUMN IF NOT EXISTS grounding_claim_count INTEGER,
  ADD COLUMN IF NOT EXISTS grounding_sourced_claim_count INTEGER,
  ADD COLUMN IF NOT EXISTS grounding_unsourced_claim_count INTEGER,
  ADD COLUMN IF NOT EXISTS grounding_invalid_source_count INTEGER;

ALTER TABLE messages
  ADD CONSTRAINT messages_grounding_complete_check CHECK (
    (
      grounding_verdict IS NULL
      AND grounding_claim_count IS NULL
      AND grounding_sourced_claim_count IS NULL
      AND grounding_unsourced_claim_count IS NULL
      AND grounding_invalid_source_count IS NULL
    )
    OR
    (
      grounding_verdict IS NOT NULL
      AND grounding_claim_count IS NOT NULL
      AND grounding_sourced_claim_count IS NOT NULL
      AND grounding_unsourced_claim_count IS NOT NULL
      AND grounding_invalid_source_count IS NOT NULL
    )
  ),
  ADD CONSTRAINT messages_grounding_verdict_check CHECK (
    grounding_verdict IS NULL
    OR grounding_verdict IN ('grounded', 'degraded', 'no_support')
  ),
  ADD CONSTRAINT messages_grounding_counts_check CHECK (
    grounding_claim_count IS NULL
    OR (
      grounding_claim_count >= 0
      AND grounding_sourced_claim_count >= 0
      AND grounding_unsourced_claim_count >= 0
      AND grounding_invalid_source_count >= 0
      AND grounding_sourced_claim_count + grounding_unsourced_claim_count = grounding_claim_count
    )
  );

-- Choose the latest eligible lifecycle event before validating it. An invalid
-- newest event deliberately does not fall back to older complete metadata.
WITH latest AS (
  SELECT DISTINCT ON (m.id)
    m.id AS message_id,
    e.metadata_json
  FROM messages m
  JOIN audit_events e
    ON e.workspace_id = m.workspace_id
   AND e.event_type IN ('chat.answer', 'chat.suspended')
   AND e.metadata_json ->> 'assistantMessageId' = m.id::text
  WHERE m.role = 'assistant'
    AND m.grounding_verdict IS NULL
    AND m.grounding_claim_count IS NULL
    AND m.grounding_sourced_claim_count IS NULL
    AND m.grounding_unsourced_claim_count IS NULL
    AND m.grounding_invalid_source_count IS NULL
  ORDER BY m.id, e.created_at DESC, e.id DESC
),
valid AS (
  SELECT
    message_id,
    metadata_json ->> 'groundingVerdict' AS verdict,
    (metadata_json #>> '{groundingDiagnostics,claimCount}')::numeric AS claim_count,
    (metadata_json #>> '{groundingDiagnostics,sourcedClaimCount}')::numeric AS sourced_claim_count,
    (metadata_json #>> '{groundingDiagnostics,unsourcedClaimCount}')::numeric AS unsourced_claim_count,
    (metadata_json #>> '{groundingDiagnostics,invalidSourceCount}')::numeric AS invalid_source_count
  FROM latest
  WHERE metadata_json ->> 'groundingVerdict' IN ('grounded', 'degraded', 'no_support')
    AND jsonb_typeof(metadata_json #> '{groundingDiagnostics,claimCount}') = 'number'
    AND jsonb_typeof(metadata_json #> '{groundingDiagnostics,sourcedClaimCount}') = 'number'
    AND jsonb_typeof(metadata_json #> '{groundingDiagnostics,unsourcedClaimCount}') = 'number'
    AND jsonb_typeof(metadata_json #> '{groundingDiagnostics,invalidSourceCount}') = 'number'
),
safe AS (
  SELECT *
  FROM valid
  WHERE claim_count = trunc(claim_count)
    AND sourced_claim_count = trunc(sourced_claim_count)
    AND unsourced_claim_count = trunc(unsourced_claim_count)
    AND invalid_source_count = trunc(invalid_source_count)
    AND claim_count BETWEEN 0 AND 2147483647
    AND sourced_claim_count BETWEEN 0 AND 2147483647
    AND unsourced_claim_count BETWEEN 0 AND 2147483647
    AND invalid_source_count BETWEEN 0 AND 2147483647
    AND sourced_claim_count + unsourced_claim_count = claim_count
)
UPDATE messages m
SET grounding_verdict = safe.verdict,
    grounding_claim_count = safe.claim_count::integer,
    grounding_sourced_claim_count = safe.sourced_claim_count::integer,
    grounding_unsourced_claim_count = safe.unsourced_claim_count::integer,
    grounding_invalid_source_count = safe.invalid_source_count::integer
FROM safe
WHERE m.id = safe.message_id
  AND m.grounding_verdict IS NULL
  AND m.grounding_claim_count IS NULL
  AND m.grounding_sourced_claim_count IS NULL
  AND m.grounding_unsourced_claim_count IS NULL
  AND m.grounding_invalid_source_count IS NULL;

-- No new index: the existing workspace/role/created-at index bounds Quality's
-- assistant-turn population before these secondary filters are applied.
