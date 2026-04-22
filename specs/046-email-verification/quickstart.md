# Quickstart: Email Verification Gate

1. Register a new user through `/api/v1/auth/register`.
2. Confirm the response includes `requiresEmailVerification: true` and does not set a session cookie.
3. Attempt login before verification and confirm the API returns `403 email_verification_required`.
4. Read the sent verification email from the test email driver and extract the token.
5. Verify with `POST /api/v1/auth/email-verification/verify`.
6. Login again and confirm the existing authenticated bootstrap flow succeeds.
7. Request `POST /api/v1/auth/email-verification/resend` for an unverified user and confirm a new token is issued.
8. Retry an older token after resend and confirm it is rejected.
