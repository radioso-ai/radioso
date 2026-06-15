# Quickstart: Workspace Email Connections and Skills

This quickstart describes the target behavior for validation after implementation.

## Operator: connect customer email

1. Open workspace settings.
2. Go to customer email connections.
3. Choose a supported OAuth mail provider.
4. Start authorization.
5. Complete provider consent.
6. Return to Radioso and confirm the connection status is `authorized`.
7. Create a customer email connection with a sender identity.

Expected result: the connection list shows provider, sender identity, status, and last health result. No token or secret is visible.

## Agent author: create an email skill

1. Open the agent settings.
2. Go to email skills.
3. Choose the workspace email connection.
4. Name the skill, for example `support_email_customer`.
5. Choose `draft` mode for the first test.
6. Bind `replyTo` to the support address.
7. Expose `to`, `subject`, and `bodyText` to routine slots.
8. Save the skill.

Expected result: the skill appears as enabled and lists branchable outcomes.

## Routine author: invoke the skill

1. Open routine authoring for the agent.
2. Add or edit a routine that collects `customerEmail`, `emailSubject`, and `emailBody`.
3. Add a skill step that invokes `support_email_customer`.
4. Map routine slots to exposed email inputs.
5. Add branches for `drafted`, `missing_input`, and `needs_reauth`.
6. Publish the routine.

Expected result: completing the routine creates a draft through the customer's provider and the routine follows the `drafted` branch.

## Send-mode validation

1. Edit the skill and switch mode to `send`.
2. Run the same routine with a safe test recipient.
3. Confirm the provider reports a sent message.
4. Confirm activity shows `sent` without storing body content or secrets.

## Failure validation

- Disable the email connection and run the routine: expect `disabled_connection`.
- Revoke provider consent and run the routine: expect `needs_reauth`.
- Omit a required slot and run the routine: expect `missing_input`.
- Configure the mock provider to reject the message: expect `provider_rejected`.

## Regression validation

- Request password reset or email verification after adding a customer email connection.
- Confirm Radioso-owned transactional email still uses the system mail configuration, not the customer email connection.

## Suggested focused checks

```bash
cd backend
pnpm test -- tests/unit/customer-email*.test.ts tests/integration/customerEmail/*.test.ts
pnpm run test:contract

cd ../frontend
pnpm test -- tests/unit/email-skills*.test.ts
pnpm run test:e2e -- email-skills
```
