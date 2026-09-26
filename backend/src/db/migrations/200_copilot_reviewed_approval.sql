ALTER TABLE copilot_proposals
  ADD COLUMN confirmation_requirement text NULL CHECK (confirmation_requirement IN ('conversation', 'signed_in_approval')),
  ADD COLUMN change_effect jsonb NULL,
  ADD COLUMN approved_at timestamptz NULL,
  ADD COLUMN approved_by_user_id uuid NULL,
  ADD COLUMN approval_digest text NULL;

-- A pending reviewed row was created before it carried an effect and cannot safely be tiered.
-- Settle the small (15-minute) deploy window as stale so callers prepare a fresh review.
UPDATE copilot_proposals
  SET status = 'stale', confirmation_requirement = 'conversation', updated_at = now()
  WHERE review_digest IS NOT NULL AND status = 'pending';

UPDATE copilot_proposals
  SET confirmation_requirement = 'conversation'
  WHERE review_digest IS NOT NULL AND confirmation_requirement IS NULL;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_reviewed_requirement_check
    CHECK (review_digest IS NULL OR confirmation_requirement IS NOT NULL),
  ADD CONSTRAINT copilot_proposals_approval_shape_check CHECK (
    (approved_at IS NULL) = (approved_by_user_id IS NULL)
    AND (approved_at IS NULL) = (approval_digest IS NULL)
    AND (approved_at IS NULL OR (confirmation_requirement = 'signed_in_approval' AND approval_digest = review_digest))
  );
