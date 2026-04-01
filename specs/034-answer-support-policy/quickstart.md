# Quickstart: Configurable Answer Support Policy

## Scenario 1: Load retrieval settings for an existing workspace

1. Start the backend with a workspace that has older retrieval settings and no answer-support policy saved yet.
2. Request `GET /api/v1/settings/retrieval`.
3. Confirm the response includes the new answer-support policy field.
4. Confirm the returned value defaults to `strict`.
5. Confirm the rest of the retrieval settings payload remains unchanged.

## Scenario 2: Save the policy from the settings UI

1. Open the Settings view and navigate to `Retrieval`.
2. Choose one of `strict`, `warn`, or `off` in the answer-support policy control.
3. Save the settings.
4. Reload the page.
5. Confirm the saved value and surrounding retrieval settings are preserved.

## Scenario 3: Strict mode generates a bounded unsupported notice

1. Configure the workspace answer-support policy as `strict`.
2. Ask a retrieval-backed question that produces unsupported substantive answer content.
3. Inspect the final delivered answer and stored diagnostics.
4. Confirm unsupported content was replaced.
5. Confirm the replacement is a short non-verification notice in the user’s language rather than a fixed English sentence.

## Scenario 4: Warn mode preserves the answer text

1. Configure the workspace answer-support policy as `warn`.
2. Ask a retrieval-backed question that produces unsupported substantive answer content.
3. Inspect the final delivered answer and stored diagnostics.
4. Confirm the answer text is preserved.
5. Confirm diagnostics still show that unsupported content was detected.

## Scenario 5: Off mode disables post-generation replacement

1. Configure the workspace answer-support policy as `off`.
2. Ask a retrieval-backed question that produces unsupported substantive answer content.
3. Inspect the final delivered answer and stored diagnostics.
4. Confirm no strict-style replacement was applied.
5. Confirm the workspace policy is reflected in the stored turn metadata.

## Scenario 6: Anonymous/public chat follows the same workspace policy

1. Configure the workspace answer-support policy to a non-default mode such as `warn` or `off`.
2. Trigger the same style of retrieval-backed question through an anonymous/public chat entry point.
3. Inspect the final delivered answer and stored diagnostics.
4. Confirm the anonymous/public answer follows the same policy behavior as authenticated chat in that workspace.
