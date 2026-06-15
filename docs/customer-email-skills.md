# Customer Email Connections

Customer email connections are workspace-owned outbound mail resources. They are
separate from Radioso transactional email.

The key point is that password reset, email verification, invitations, and other
product messages still use `backend/src/modules/mail/`. Customer email
connections are for customer-authorized outbound email that can later be exposed
as constrained agent skills.

## Setup

Customer email starts with OAuth. Set the shared OAuth encryption and app URL
configuration:

```bash
CONNECTOR_ENCRYPTION_KEY=...
APP_BASE_URL=https://app.example.com
```

Then configure the provider client credentials you want to enable:

```bash
GOOGLE_MAIL_OAUTH_CLIENT_ID=...
GOOGLE_MAIL_OAUTH_CLIENT_SECRET=...
MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_ID=...
MICROSOFT_GRAPH_MAIL_OAUTH_CLIENT_SECRET=...
```

If a provider's client id or secret is missing, that provider is not registered.

## Connection Flow

1. Authorize a workspace OAuth mail connection from workspace settings.
2. Create a customer email connection over an authorized OAuth connection.
3. Configure the sender email, optional sender name, and optional reply-to email.
4. Use health check to verify the provider status without sending an email.

Customer email connection responses do not include OAuth access tokens, refresh
tokens, client secrets, cookies, or raw provider credentials.

## API

OAuth connections:

- `POST /api/v1/workspaces/{workspaceId}/oauth-connections`
- `GET /api/v1/workspaces/{workspaceId}/oauth-connections`
- `GET /api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}`
- `POST /api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}/reauthorize`

Customer email connections:

- `GET /api/v1/workspaces/{workspaceId}/email-connections`
- `POST /api/v1/workspaces/{workspaceId}/email-connections`
- `PATCH /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}`
- `POST /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}/health-check`
- `DELETE /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}`

Deleting a connection is blocked when an email skill references it. Disabling is
allowed, so existing skill definitions can remain in place while runtime use is
stopped.

## Skill Authoring

Agent email skills are named actions over a customer email connection. They are
allowlisted definitions, not raw provider access.

Create them from the assistant skills settings page after a workspace has at
least one authorized customer email connection.

For each skill, choose:

- a customer email connection
- a skill name, such as `support_email_customer`
- `draft` or `send` mode
- which inputs are fixed by the author
- which inputs are exposed for conversation or routine slot filling
- whether the skill is enabled

Required logical inputs must be covered before the skill can be saved:

- `to`
- `subject`
- `bodyText` or `bodyHtml`

Optional first-slice inputs are:

- `cc`
- `replyTo`

Bound and exposed inputs must be separate. For example, `subject` cannot be both
fixed by the author and filled by a routine slot. `draft` is the safer default.
Switching to `send` is explicit.

Email skill definition endpoints:

- `GET /api/v1/agents/{agentId}/email-skills`
- `POST /api/v1/agents/{agentId}/email-skills`
- `GET /api/v1/agents/{agentId}/email-skills/{skillId}`
- `PATCH /api/v1/agents/{agentId}/email-skills/{skillId}`
- `DELETE /api/v1/agents/{agentId}/email-skills/{skillId}`

The response includes the stable outcomes that routines use for branching:

- `drafted`
- `sent`
- `missing_input`
- `disabled_connection`
- `needs_reauth`
- `provider_rejected`
- `failed`

Only defined and enabled skills are callable by routines. A routine tool step
uses the skill name, for example `support_email_customer`. The routine runtime
resolves that name through the shared skill executor path. It does not call a
mail provider directly and does not handle OAuth tokens.

## Routine Outcomes

Routine tool steps can branch on email skill outcomes with an `outcome` guard.
Use the stable outcome value, not provider-specific text.

In practice:

- `drafted`: the provider accepted a draft creation request.
- `sent`: the provider accepted an immediate send request.
- `missing_input`: a required exposed input was not available in routine state.
- `disabled_connection`: the referenced customer email connection is disabled.
- `needs_reauth`: the OAuth connection is no longer usable and must be
  reauthorized.
- `provider_rejected`: the provider rejected the draft or send request, such as
  a quota or policy rejection.
- `failed`: the runtime could not complete the request for another sanitized
  reason, such as timeout or unavailable provider configuration.

Provider calls are bounded by a timeout. Runtime outcomes and logs use stable
sanitized codes. They must not include OAuth tokens, refresh tokens, client
secrets, cookies, connection strings, or full message bodies.

## Transactional Mail Boundary

Do not route Radioso-owned mail through customer email connections.

In practice:

- Password reset continues through `PasswordResetService` and `modules/mail`.
- Email verification continues through `EmailVerificationService` and
  `modules/mail`.
- Customer email code lives under `backend/src/modules/customerEmail/`.
- OAuth token lifecycle lives under `backend/src/modules/integrationOauth/`.
