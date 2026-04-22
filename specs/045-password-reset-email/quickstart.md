# Quickstart: Password Reset Email Recovery

## Backend validation flow

1. Start the stack with `./run-dev.sh`.
2. Register a user through `POST /api/v1/auth/register`.
3. Request password reset through `POST /api/v1/auth/password-reset/request`.
4. In local `MAIL_DRIVER=log` or `MAIL_DRIVER=noop` mode, inspect the emitted reset URL from backend logs or test doubles.
5. Confirm the reset through `POST /api/v1/auth/password-reset/confirm` with the raw token and a new password.
6. Verify the response sets a fresh session cookie and returns an accessible workspace/account payload.
7. Attempt an authenticated request with an old session cookie and confirm it now fails.
8. Sign in with the new password and confirm the user can access their existing account memberships.

## Frontend validation flow

1. Open `http://localhost:3000`.
2. From the login card, use `Forgot password?`.
3. Submit a known email and then an unknown email; confirm both show the same safe success state.
4. Follow a valid reset link into the reset page and set a new password.
5. Open an expired or already-used reset link and confirm the page directs the user to request a new email.

## Regression checks

1. Existing register, login, invitation acceptance, and workspace switching flows still pass.
2. Generated OpenAPI outputs match the updated auth routes.
3. `readme.md` and `backend/.env.example` document the new mail configuration and password reset flow.

## Validation Results

- `backend`: `npm test -- --run tests/unit/password-reset-service.test.ts tests/unit/email-service.test.ts tests/integration/password-reset.integration.test.ts tests/contract/auth.contract.test.ts tests/unit/runtime-startup.test.ts`
- `backend`: `npm run build`
- `frontend`: `npm test -- --run tests/unit/password-reset-flow.test.tsx tests/unit/account-api.test.ts`
- `frontend`: `npm run build`
