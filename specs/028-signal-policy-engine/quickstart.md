# Quickstart: Generic Retrieval Signal Policies

## Scenario 1: Load retrieval settings for a legacy workspace

1. Start the backend with a workspace whose retrieval settings were saved before this feature.
2. Request `GET /api/v1/settings/retrieval`.
3. Confirm the response includes `signalPolicies` and does not include `attributeControls`.
4. Confirm the returned policies reflect the legacy workspace defaults or previously saved legacy settings.

## Scenario 2: Save generic signal policies from the settings UI

1. Open the Settings view and navigate to `Retrieval`.
2. Confirm the retrieval policy section does not show the four legacy attribute-family labels.
3. Change one or more signal policy toggles or modes.
4. Save the settings.
5. Reload the page and confirm the updated policies are preserved.

## Scenario 3: Preserve baseline retrieval when no signal policy matches

1. Use a query without date, amount, or location literals.
2. Run retrieval with signal policies enabled.
3. Confirm retrieval still returns candidates and does not fail or hard-filter unexpectedly.

## Scenario 4: Apply generic policies during retrieval

1. Use a query that contains a supported literal, such as a date or amount.
2. Ensure the corresponding signal policy is enabled.
3. Run retrieval and inspect diagnostics or covered tests.
4. Confirm the applied constraints list references signal-policy application through the new generic model rather than legacy family enums.
