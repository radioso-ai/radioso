# Quickstart: Async Document Processing

## Validation Flow

1. Start from the feature worktree on branch `012-async-document-processing`.
2. Run backend unit, contract, and targeted integration tests covering document command acceptance, worker processing, retry behavior, and stale-revision protection.
3. Run frontend lint validation for the document status and polling updates.
4. Create a document through the API and verify the initial response returns an accepted non-final status.
5. Confirm the worker advances the document through queued or processing to ready without another API request.
6. Force a processing error and verify the document reaches failed status with a visible retry path.
7. Reprocess the failed document and confirm it returns to queued, then reaches ready.
8. Update the same document twice quickly and verify only the latest revision becomes ready.
9. Delete a queued document and verify late worker completion does not recreate chunks or ready status.
