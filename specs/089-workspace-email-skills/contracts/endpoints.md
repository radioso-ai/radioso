# Endpoint Contract Notes: Workspace Email Connections and Skills

These are design-time notes. Runtime contracts must be implemented in the code-first OpenAPI registry under `backend/src/app/http/openapi/` using shared Zod schemas; `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.

## OAuth Connections

### `POST /api/v1/workspaces/{workspaceId}/oauth-connections`

Create a pending OAuth connection and return an authorization URL.

Request:

```json
{
  "provider": "google_mail",
  "displayName": "Support Gmail",
  "requestedScopes": ["mail.send", "mail.compose"]
}
```

Response:

```json
{
  "connectionId": "uuid",
  "authorizationUrl": "https://provider.example/oauth/authorize?...",
  "status": "pending"
}
```

### `GET /api/v1/oauth/callback/{provider}`

Completes provider callback. Validates state, exchanges code, stores encrypted credential state, and redirects to the dashboard connection status page.

### `POST /api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}/reauthorize`

Starts a new authorization flow for an existing connection.

### `GET /api/v1/workspaces/{workspaceId}/oauth-connections/{connectionId}`

Returns non-secret OAuth status.

Response:

```json
{
  "id": "uuid",
  "provider": "google_mail",
  "displayName": "Support Gmail",
  "status": "authorized",
  "grantedScopes": ["mail.send", "mail.compose"],
  "providerAccountId": "redacted-or-provider-id",
  "updatedAt": "2026-06-15T00:00:00.000Z"
}
```

## Customer Email Connections

### `GET /api/v1/workspaces/{workspaceId}/email-connections`

List workspace customer email connections.

### `POST /api/v1/workspaces/{workspaceId}/email-connections`

Create a customer email connection over an authorized OAuth connection.

Request:

```json
{
  "oauthConnectionId": "uuid",
  "displayName": "Support outbound",
  "senderEmail": "support@example.com",
  "senderName": "Example Support",
  "replyToEmail": "support@example.com"
}
```

Response returns non-secret connection summary.

### `PATCH /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}`

Update display name, sender defaults, or disabled state.

### `DELETE /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}`

Deletes a connection only when no email skill references it.

### `POST /api/v1/workspaces/{workspaceId}/email-connections/{connectionId}/health-check`

Performs provider status validation without sending an email when the provider supports it.

## Email Skill Definitions

### `GET /api/v1/agents/{agentId}/email-skills`

List email skill definitions for an agent.

### `POST /api/v1/agents/{agentId}/email-skills`

Create an allowlisted email skill.

Request:

```json
{
  "skillName": "support_email_customer",
  "connectionId": "uuid",
  "mode": "draft",
  "boundInputs": {
    "replyTo": "support@example.com"
  },
  "exposedInputs": {
    "to": { "slotBinding": "customerEmail" },
    "subject": { "slotBinding": "emailSubject" },
    "bodyText": { "slotBinding": "emailBody" }
  },
  "enabled": true
}
```

Response:

```json
{
  "id": "uuid",
  "skillName": "support_email_customer",
  "connectionId": "uuid",
  "mode": "draft",
  "enabled": true,
  "outcomes": ["drafted", "sent", "missing_input", "disabled_connection", "needs_reauth", "provider_rejected", "failed"]
}
```

### `PATCH /api/v1/agents/{agentId}/email-skills/{skillId}`

Update mode, bindings, or enabled status.

### `DELETE /api/v1/agents/{agentId}/email-skills/{skillId}`

Delete a skill definition.

## Activity

### `GET /api/v1/workspaces/{workspaceId}/email-skill-activity`

List sanitized activity records, filterable by agent, connection, skill, outcome, and date range.

## Skill Runtime Contract

Email skills are invoked through the existing routine/skill executor path, not a public generic execute endpoint.

Inputs passed to the executor:

```json
{
  "to": "customer@example.com",
  "subject": "Follow-up",
  "bodyText": "Thanks for contacting us."
}
```

Settled outcomes:

- `drafted`
- `sent`
- `missing_input`
- `disabled_connection`
- `needs_reauth`
- `provider_rejected`
- `failed`

## Message Queue Impact

No new document worker dispatch, AMQP payload, or retry contract is planned for the first slice. If a later phase adds deferred email delivery, it must define a new queue payload, idempotency key semantics, retry limits, and queue contract tests before implementation.
