-- Queues, once per database, the sweep for stored files whose workspace this database no longer
-- has: the uploads and logos of workspaces and organizations deleted before a deletion handed its
-- files to the worker. The worker runs it as the `documents.orphaned_workspace_storage_sweep`
-- background job (backend/src/modules/documents/services/orphanedWorkspaceStorageSweep.ts), which
-- deletes nothing unless the store holds the files of a workspace this database records, and
-- queues one `documents.workspace_storage_purge` job per orphaned workspace.
--
-- The payload and key are the ones `orphanedWorkspaceStorageSweepRequest(null)` builds. A worker
-- claims only kinds it has a handler for, so a worker from an earlier release leaves the row for
-- one that has it. No lock beyond the row insert.
INSERT INTO background_jobs (kind, payload, idempotency_key)
VALUES ('documents.orphaned_workspace_storage_sweep', '{"cursor": null}'::jsonb, 'start')
ON CONFLICT DO NOTHING;
