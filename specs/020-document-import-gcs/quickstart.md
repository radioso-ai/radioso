# Quickstart: Document Import and GCS Storage

## Local Validation Setup

1. Start from the feature worktree on branch `020-document-import-gcs`.
2. Configure backend env values for the document-import bucket in `backend/.env`.
3. For localhost authentication, use one of:
   - `export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/local-service-account.json`
   - an existing application-default-credentials login for the active shell
4. Ensure the configured GCS bucket already exists and the credentials can read and write objects in it.

## Validation Flow

1. Run backend contract tests covering:
   - manual text document create remains unchanged
   - multipart file import acceptance
   - reprocess behavior for uploaded documents
   - delete behavior for uploaded documents
2. Run backend unit tests covering:
   - parser dispatch and extraction behavior
   - import orchestration and storage failure handling
   - worker-time source materialization for inline and uploaded documents
3. Run targeted backend integration/persistence tests for the additive document schema and deletion/reprocess behavior.
4. Run frontend lint validation.
5. Start backend and frontend locally.
6. In Documents, upload one `.txt`, `.pdf`, `.docx`, and `.xlsx` sample file and confirm each is accepted and appears in the list with pending status.
7. Wait for processing to finish and verify each successful import transitions to ready and can answer a relevant chat question.
8. Upload an unsupported or zero-byte file and verify the UI shows a clear error without creating a ready document.
9. Reprocess an imported document and verify it succeeds without another upload.
10. Delete an imported document and verify both the document row and stored object are removed.
