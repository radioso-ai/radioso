-- Freeze the rolling per-conversation summary (#866) at snapshot time so a workbench
-- replay or eval run sees the same pre-window context a live turn would. The summary
-- text is captured verbatim as of capture time (per-turn historical summaries are not
-- persisted, so this is the faithful achievable parity). NULL for snapshots captured
-- before this column existed and for short/new conversations with no summary.
ALTER TABLE public.eval_snapshots
  ADD COLUMN IF NOT EXISTS original_conversation_summary jsonb;
