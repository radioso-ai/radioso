-- Migration 006: Change audit_events.workspace_id FK to SET NULL on workspace delete
-- This allows workspace deletion without losing audit trail records.
-- The workspace_id column becomes NULL for audit events of deleted workspaces.

DO $$
BEGIN
  -- Drop the existing FK constraint (find it by column reference)
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = 'audit_events'
      AND kcu.column_name = 'workspace_id'
      AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE audit_events DROP CONSTRAINT ' || tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'audit_events'
        AND kcu.column_name = 'workspace_id'
        AND tc.constraint_type = 'FOREIGN KEY'
      LIMIT 1
    );
  END IF;

  -- Re-add with ON DELETE SET NULL
  ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
END $$;
