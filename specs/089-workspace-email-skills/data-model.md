# Data Model: Workspace Email Connections and Skills

## OAuth Connection

Provider-neutral authorization record for third-party integration credentials.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| workspaceId | uuid | Owning workspace |
| provider | string | e.g. `google_mail`, `microsoft_graph_mail`, `mcp` |
| providerAccountId | string nullable | Non-secret provider identity when available |
| displayName | text | Operator label |
| status | enum | `pending`, `authorized`, `needs_reauth`, `disabled`, `error` |
| grantedScopes | text[] | Scopes granted by provider |
| tokenSetCiphertext | text nullable | Encrypted access/refresh token set |
| oauthClientCiphertext | text nullable | Encrypted client override if provider requires per-workspace client config |
| encryptionKeyId | text nullable | Key identifier when available |
| lastRefreshAt | timestamptz nullable | Last successful refresh |
| lastErrorCode | text nullable | Sanitized status reason |
| createdAt | timestamptz | Created time |
| updatedAt | timestamptz | Updated time |

### Validation

- Tokens and client secrets are never returned in API responses.
- `authorized` requires encrypted token material and required scopes.
- `needs_reauth` is set when refresh fails, consent is revoked, or required scopes are missing.
- `disabled` prevents consumer modules from using credentials.

### State Transitions

```text
pending -> authorized
pending -> error
authorized -> authorized       # refresh success
authorized -> needs_reauth     # refresh failure / revoked consent / missing scopes
authorized -> disabled
needs_reauth -> authorized     # reauthorization success
disabled -> authorized         # operator re-enables usable credential
disabled -> needs_reauth       # operator re-enables but credential is stale
any -> error                   # unexpected provider/setup error
```

## Customer Email Connection

Workspace-owned outbound email resource backed by an OAuth connection.

> Spec 092 Phase R folds this persistence model into the provider-neutral
> `integration_connections` spine. The customer-email API shape is unchanged:
> lifecycle fields map to the spine, and `senderEmail` / `senderName` /
> `replyToEmail` are stored in spine `config`.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| workspaceId | uuid | Owning workspace |
| oauthConnectionId | uuid | Reusable OAuth credential reference |
| provider | string | Mail provider |
| displayName | text | Operator label |
| senderEmail | text | Validated sender identity |
| senderName | text nullable | Optional display name |
| replyToEmail | text nullable | Optional default reply-to |
| status | enum | `authorized`, `disabled`, `needs_reauth`, `error` |
| lastHealthStatus | enum nullable | `ok`, `failed`, `unknown` |
| lastHealthCheckedAt | timestamptz nullable | Health check time |
| lastErrorCode | text nullable | Sanitized reason |
| createdAt | timestamptz | Created time |
| updatedAt | timestamptz | Updated time |

### Validation

- `senderEmail` must be a valid email and must be allowed by the provider credential.
- Connection cannot be deleted while enabled email skills reference it.
- Disabling a connection is allowed even when skills reference it; runtime returns `disabled_connection`.
- Connection never affects `backend/src/modules/mail/` transactional delivery.

## Email Skill Definition

Agent-visible allowlisted action over a customer email connection.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| workspaceId | uuid | Owning workspace |
| agentId | uuid | Agent that can invoke this skill |
| connectionId | uuid | Customer email connection |
| skillName | text | Unique within agent; routine skill identifier |
| mode | enum | `draft` or `send` |
| boundInputs | jsonb | Author-fixed values |
| exposedInputs | jsonb | Conversation/routine-filled fields |
| enabled | boolean | Runtime allowlist flag |
| createdAt | timestamptz | Created time |
| updatedAt | timestamptz | Updated time |

### Required Logical Inputs

- `to`
- `subject`
- `bodyText` or `bodyHtml`
- optional `cc`
- optional `bcc` only if explicitly enabled later; default out of scope
- optional `replyTo`

### Validation

- `skillName` follows existing routine skill naming convention: lower-case identifier unique within an agent.
- Required logical inputs must be either bound or exposed.
- Bound and exposed input keys must be disjoint.
- Recipient inputs must validate before provider calls.
- `mode = send` must be explicit.

## Email Skill Run Activity

Sanitized record of customer email skill execution.

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable reference |
| workspaceId | uuid | Owning workspace |
| agentId | uuid | Invoking agent |
| routineId | uuid nullable | Routine context when available |
| conversationId | uuid nullable | Conversation context when available |
| skillDefinitionId | uuid | Invoked email skill |
| connectionId | uuid | Email connection used |
| mode | enum | `draft` or `send` |
| outcome | enum | `drafted`, `sent`, `missing_input`, `disabled_connection`, `needs_reauth`, `provider_rejected`, `failed` |
| recipientSummary | jsonb | Sanitized metadata, e.g. recipient count and domains or redacted email |
| providerMessageId | text nullable | Provider id when safe to store |
| errorCode | text nullable | Sanitized failure code |
| createdAt | timestamptz | Run time |

### Privacy Rules

- Do not store OAuth tokens, refresh tokens, client secrets, cookies, or connection strings.
- Do not store full message body by default.
- Store raw recipient addresses only if product policy explicitly allows it; default should minimize to count/domain/redacted metadata.

## Relationship Summary

```text
Workspace
  ├── OAuthConnection
  │     └── CustomerEmailConnection
  │            └── EmailSkillDefinition (per agent)
  │                   └── EmailSkillRunActivity
  └── Radioso transactional mail config (separate; existing modules/mail path)
```
