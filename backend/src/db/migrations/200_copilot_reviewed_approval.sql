ALTER TABLE copilot_proposals
  ADD COLUMN confirmation_requirement text NULL CHECK (confirmation_requirement IN ('conversation', 'signed_in_approval')),
  ADD COLUMN change_effect jsonb NULL,
  ADD COLUMN approved_at timestamptz NULL,
  ADD COLUMN approved_by_user_id uuid NULL,
  ADD COLUMN approval_digest text NULL;

UPDATE copilot_proposals
  SET confirmation_requirement = CASE WHEN status = 'pending' THEN 'signed_in_approval' ELSE 'conversation' END
  WHERE review_digest IS NOT NULL;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_reviewed_requirement_check
    CHECK (review_digest IS NULL OR confirmation_requirement IS NOT NULL),
  ADD CONSTRAINT copilot_proposals_approval_shape_check CHECK (
    (approved_at IS NULL) = (approved_by_user_id IS NULL)
    AND (approved_at IS NULL) = (approval_digest IS NULL)
    AND (approved_at IS NULL OR (confirmation_requirement = 'signed_in_approval' AND approval_digest = review_digest))
  );
