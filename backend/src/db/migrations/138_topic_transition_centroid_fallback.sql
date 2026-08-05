-- Identity matching (spec 956 US2) falls back to centroid similarity when a run and
-- its prior share no members. That path is weaker than membership containment, so
-- readers need to tell a transition decided by it apart from one grounded in overlap.

ALTER TABLE topic_transitions
  ADD COLUMN IF NOT EXISTS via_centroid_fallback BOOLEAN NOT NULL DEFAULT false;
