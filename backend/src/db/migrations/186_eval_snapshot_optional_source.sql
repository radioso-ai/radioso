-- Private Test Chat turns are durable evidence but intentionally have no live
-- conversation or message rows. Keep ordinary source foreign keys intact while
-- allowing those snapshots to declare that their source is private.
ALTER TABLE public.eval_snapshots
  ALTER COLUMN source_conversation_id DROP NOT NULL;
