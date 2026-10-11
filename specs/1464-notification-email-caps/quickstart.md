# Quickstart: Validate Notification Email Caps And Hygiene

## Prerequisites

- Dependencies are already installed.
- The disposable integration database from issue #1464 is running.
- `DATABASE_URL`, `INTEGRATION_DATABASE_URL`, and `RADIOSO_INTEGRATION_DATABASE_NAME` point to the provided databases.

## Focused Validation

1. Run delivery-policy unit and repository integration tests. Expect one durable decision per request, no more than five allowed requests per conversation, and no daily overrun under concurrent calls.
2. Run contact-handler and operator-notification sink tests. Expect `contact_notification` / `operator_notice` mail kinds, bounded visitor text, invalid reply-to omission, signed webhooks, and cap-specific skip behavior.
3. Run agent and skill route/service tests. Expect member recipient mutations to return forbidden, owner/admin mutations to succeed, and safe audit hashes/counts.
4. Run plan-catalog and EE usage-policy tests. Expect every plan to expose a positive daily allowance and the assigned plan to resolve it.
5. Run product-docs sync and its check after documentation edits.

## Required Gates

Run the exact backend, frontend-if-touched, EE-if-touched, ESLint, dead-code, and focused-test commands from the issue task. Regenerate database schema/type snapshots after the migration. No public OpenAPI schema generation is expected because request and response shapes do not change.

## Expected Operational Evidence

- `notification_delivery_outcomes` stores `workspace_daily_email_cap` or `conversation_dispatch_cap` without any address.
- Audit events for skips contain only IDs, counts, limits, and the bounded reason.
- Recipient change audit events contain counts and hashes, never raw recipient values.
