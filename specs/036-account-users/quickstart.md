# Quickstart: Account Multi-User Access

## Scenario 1: Existing user invites a teammate

1. Register a new account.
2. Open the bottom-left user menu and navigate to Users.
3. Submit an invite for `teammate@example.com`.
4. Verify the Users page shows one active user and one pending invitation.

## Scenario 2: Invited teammate joins the account

1. Copy the acceptance URL from the pending invitation.
2. Open the invitation URL in a fresh browser session.
3. Complete the join flow with the invited email and a password.
4. Verify the response lands on the invited account dashboard and the workspace switcher shows the account's workspaces.

## Scenario 3: Existing person joins an additional account

1. Register Account A with `person@example.com`.
2. Register Account B with a different owner.
3. From Account B, create an invitation for `person@example.com`.
4. Open the invite URL and accept it with the existing password for `person@example.com`.
5. Verify the user can access Account B and future logins can return to the correct account context.

## Scenario 4: Shared workspace access remains uniform

1. On an account with two active users, create a second workspace as User 1.
2. Sign in as User 2.
3. Verify User 2 sees both workspaces and can open the new workspace without authorization failures.
