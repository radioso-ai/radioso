---
title: "Customer Email Connections"
description: "Setup of workspace-owned outbound email connections and unified agent email skills for draft and send modes."
last_updated: 2026-06-23
---

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

Create them from the agent's **Skills** list with **Add new skill** after the
workspace has at least one authorized customer email connection. The picker
shows capability tiles; **Email** is enabled when an email connection exists.
The email connection remains managed in workspace settings; the skill form only
binds to that connected target.

For each skill, choose:

- the **Email** capability
- a customer email connection
- a skill name, such as `support_email_customer`
- `draft` or `send` mode

The form exposes required inputs to the routine by default and skips optional
inputs. Open **Advanced** only when you need to bind a fixed input value, include
an optional input, change invocation behavior, narrow outcomes, edit raw config,
or disable the skill.

Required logical inputs are:

- `to`
- `subject`
- `bodyText` or `bodyHtml`

Optional first-slice inputs are:

- `cc`
- `replyTo`

Bound and exposed inputs must be separate. For example, `subject` cannot be both
fixed by the author and filled by a routine slot. `draft` is the safer default.
Switching to `send` is explicit.

The unified skill endpoints are:

- `GET /api/v1/agents/{agentId}/skill-capabilities`
- `GET /api/v1/agents/{agentId}/skills`
- `POST /api/v1/agents/{agentId}/skills`
- `PATCH /api/v1/agents/{agentId}/skills/{skillId}`
- `DELETE /api/v1/agents/{agentId}/skills/{skillId}`

Legacy email skill definition endpoints may remain available during cutover:

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

## Provider Delivery Status

The connection, skill, OAuth, and activity paths are complete. The provider
adapter that talks to Gmail or Microsoft Graph is not wired yet. The current
build uses a mock provider for both `google_mail` and `microsoft_graph_mail`.

The key point is that no real email is sent yet. The mock provider accepts every
draft and send request and returns a placeholder message id. So a `drafted` or
`sent` outcome means the request passed validation and reached the provider
step, not that a message was delivered. Activity receipts are not proof of
delivery.

The backend logs a warning at startup when the mock provider is active. Treat
delivery as simulated until a real provider adapter is wired.

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

## Activity and Inspection

Workspace settings include an email skill activity view. It shows recent
customer email skill runs with sanitized metadata:

- skill name
- agent id and optional routine or conversation context
- connection id
- draft or send mode
- stable outcome
- recipient count, domains, and redacted recipient hints
- sanitized provider message id or error code when available
- timestamp

The activity endpoint is:

- `GET /api/v1/workspaces/{workspaceId}/email-skill-activity`

It can be filtered by agent, connection, skill definition, outcome, and date
range.

The key point is that activity is not a message archive. Radioso does not retain
full message bodies by default. Activity records also do not store OAuth access
tokens, refresh tokens, client secrets, cookies, connection strings, raw provider
credentials, or raw provider error payloads.

When `needs_reauth` appears in activity, reauthorize the OAuth connection before
expecting skills that use that connection to draft or send again. When
`disabled_connection` appears, re-enable the customer email connection if that
runtime path should be allowed.

## Transactional Mail Boundary

Do not route Radioso-owned mail through customer email connections.

In practice:

- Password reset continues through `PasswordResetService` and `modules/mail`.
- Email verification continues through `EmailVerificationService` and
  `modules/mail`.
- Customer email code lives under `backend/src/modules/customerEmail/`.
- OAuth token lifecycle lives under `backend/src/modules/integrationOauth/`.
