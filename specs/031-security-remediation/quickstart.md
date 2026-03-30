# Quickstart: Security Remediation Validation

## Prerequisites

1. Configure backend environment values, including:
   - existing database and session settings
   - valid connector encryption key
   - any new abuse-control configuration introduced by the implementation
2. Prepare a staging database with:
   - at least one account with multiple workspaces
   - at least one connector configuration containing secret fields
   - optional legacy plaintext connector-secret fixture if migration behavior is being tested
3. Install dependencies and generate the backend OpenAPI artifacts after contract changes.

### Recommended Commands

1. Backend targeted validation:
   - `cd backend && npm test -- --run tests/contract/auth.contract.test.ts tests/contract/chat.contract.test.ts tests/contract/connectors/connectorRoutes.test.ts tests/contract/connectors/connectorLifecycle.test.ts tests/contract/document.contract.test.ts tests/contract/general-settings.contract.test.ts tests/contract/public-chat.contract.test.ts tests/contract/settings.contract.test.ts tests/integration/auth.integration.test.ts tests/integration/auth-session.integration.test.ts tests/integration/abuse-controls.integration.test.ts tests/integration/document-import.integration.test.ts tests/integration/connectors/legacy-secret-remediation.integration.test.ts tests/integration/runtime-entrypoints.integration.test.ts tests/unit/abuse-control-repository.test.ts tests/unit/abuse-control-service.test.ts tests/unit/connectors/configEncryption.test.ts tests/unit/document-import-service.test.ts tests/unit/workspace-session-service.test.ts`
2. Frontend targeted validation:
   - `cd frontend && npm test -- --run tests/unit/auth-session-bootstrap.test.tsx tests/unit/workspace-session.test.tsx tests/unit/onboarding.test.ts tests/unit/chat-markdown.test.tsx`
3. Contract regeneration:
   - `cd backend && npm run generate:openapi`
4. Dependency verification:
   - `cd backend && npm audit --omit=dev`
   - `cd frontend && npm audit --omit=dev`

## Validation Flow

### 1. Admin session and workspace context

1. Sign in through the normal admin flow.
2. Verify the browser remains authenticated.
3. Switch between at least two workspaces.
4. Confirm persistent browser storage no longer contains reusable workspace bearer credentials.
5. Confirm admin API requests still resolve the active workspace correctly.

### 2. Connector secret hardening

1. Start the backend without a valid connector encryption key.
2. Confirm startup logs contain an explicit warning that connector secret writes will be rejected until `CONNECTOR_ENCRYPTION_KEY` is configured.
3. Attempt to save or update a connector configuration containing secret fields.
4. Confirm the operation fails safely with operator-visible guidance.
5. Restore a valid encryption key and repeat the save.
6. Confirm the connector can be saved successfully.
7. If a legacy plaintext fixture is present, confirm it is surfaced as remediation-required and cannot be silently trusted.
8. Re-enter the secret fields and confirm the remediation-required status clears before enable succeeds.

### 3. Abuse-control enforcement

1. Repeatedly submit failed registration or login attempts until the threshold is exceeded.
2. Confirm the documented cooldown/block response is returned.
3. Repeat the same process for:
   - workspace session or token-sensitive admin endpoints
   - authenticated upload acceptance
   - anonymous chat
4. Restart the backend or run multiple instances against the same database.
5. Confirm the limit remains effective across restart or instance boundaries.

### 4. Dependency remediation

1. Build backend and frontend on the remediated dependency graph.
2. Run the production dependency audit commands used in the security review.
3. Confirm the originally reported advisories are removed or explicitly documented as accepted temporary residual risk.
4. Exercise spreadsheet import, authenticated admin flows, and anonymous chat to verify no functional regression.

### 5. Contract and regression verification

1. Regenerate `backend/openapi.yaml` and `backend/openapi.json`.
2. Run backend contract, unit, and integration tests for auth, settings, documents, connectors, and public chat.
3. Run the targeted frontend tests for auth/bootstrap and workspace selection behavior.
4. Review audit events or logs for blocked unsafe writes and enforced abuse-control actions.
5. Confirm admin contract examples now use the session cookie plus `X-Workspace-Id` and no longer document workspace bearer-token retrieval.
