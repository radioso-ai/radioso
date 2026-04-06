# Quickstart Validation: Radioso TypeScript SDK

## Prerequisites

1. Start the backend locally so `backend/openapi.json` and the HTTP APIs are available.
2. Obtain a valid workspace API token through the existing authenticated admin flow.
3. Refresh the SDK contract snapshot from the backend before validation.

## Scenario 1: Configure the SDK for token-based requests

1. Install or link the in-repo SDK package.
2. Initialize the client with a base URL and API token.
3. Execute one supported request-response operation.
4. Verify the call succeeds without any handwritten request wrapper code.

## Scenario 2: Use a standard chat call

1. Send a supported non-streaming chat request through the SDK.
2. Verify the response shape matches the documented contract.
3. Verify optional metadata fields remain available when the backend returns them.

## Scenario 3: Use a streaming chat call

1. Start a streaming chat request through the SDK.
2. Consume the emitted typed events in order.
3. Verify completion is surfaced distinctly from incremental content.
4. Interrupt or force a failing stream and verify the SDK reports an explicit failure.

## Scenario 4: Validate unsupported auth boundaries

1. Attempt to use the SDK against a browser-session-only or admin-only operation.
2. Verify the operation is absent from the public v1 SDK surface or clearly documented as out of scope.

## Scenario 5: Refresh the SDK after a contract change

1. Change an in-scope backend contract shape in the code-first OpenAPI registry.
2. Regenerate backend OpenAPI artifacts.
3. Run the SDK sync workflow.
4. Verify generated SDK artifacts refresh from the backend contract snapshot.
5. Verify contract validation detects drift if the SDK surface is stale.
