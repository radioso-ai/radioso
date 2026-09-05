-- Full-membership overlap is a stronger narrative-stability signal than the bounded
-- display evidence stored on reports. It is nullable because emerged/dissolved and
-- centroid-fallback transitions have no containment-derived one-to-one match.

ALTER TABLE topic_transitions
  ADD COLUMN membership_overlap DOUBLE PRECISION;

ALTER TABLE topic_transitions
  ADD CONSTRAINT topic_transitions_membership_overlap_check
  CHECK (membership_overlap IS NULL OR membership_overlap BETWEEN 0 AND 1);
