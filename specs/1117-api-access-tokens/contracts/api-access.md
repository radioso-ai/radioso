# REST Contract: API Access Management

## Contract boundary

- Base path: `/api/v1/account/workspaces/{workspaceId}/api-access`
- Authentication: interactive dashboard session cookie plus CSRF protection.
- Bearer credentials never satisfy these endpoints.
- All workspace IDs are checked against the active account/session before returning existence details.
- New paths are registered in the code-first OpenAPI registry. `backend/openapi.json` and `backend/openapi.yaml` are generated outputs.
- Lifecycle types appear in generated OpenAPI/SDK snapshots, but the hand-maintained bearer SDK does not expose lifecycle helpers or claim cookie-session support.

## Shared response shapes

### Credential metadata

```json
{
  "id": "uuid",
  "kind": "personal | service",
  "label": "Local development",
  "prefix": "radioso_pat_ab12",
  "roleCeiling": "member | admin | null",
  "ownerUserId": "uuid | null",
  "serviceAccountId": "uuid | null",
  "createdByUserId": "uuid",
  "createdAt": "RFC3339 UTC",
  "expiresAt": "RFC3339 UTC",
  "expiryWarningDays": "30 | 7 | 1 | null",
  "lastUsedAt": "RFC3339 UTC | null",
  "revokedAt": "RFC3339 UTC | null",
  "revocationReason": "bounded reason | null",
  "revision": 1,
  "rotatedFromCredentialId": "uuid | null"
}
```

### One-time credential response

```json
{
  "credential": { "...": "credential metadata" },
  "secret": "radioso_pat_or_svc_<opaque-value>"
}
```

`secret` appears only in the successful issue or rotation response. It never appears in list, detail, error, audit, or retry responses.

### Paginated response

```json
{
  "items": [],
  "page": 1,
  "limit": 50,
  "total": 0
}
```

- `page` defaults to 1.
- `limit` defaults to 50 and is rejected above 100.
- Results use stable `createdAt DESC, id DESC` ordering.

### Errors

- `400`: invalid label/name, role, expiry, page, or limit.
- `401`: no valid interactive session; bearer-only request; invalid ordinary API credential.
- `403`: valid session lacks the lifecycle capability.
- `404`: record is not available in the session's account/workspace or ownership boundary.
- `409`: stale revision, invalid lifecycle transition, archived principal, or quota exceeded.

Credential authentication returns one non-enumerating `401` shape for malformed, unknown, expired, revoked, suspended, archived, and ended-tenure cases. Internal bounded reasons are not returned to the client.

## API-access summary

### `GET /api/v1/account/workspaces/{workspaceId}/api-access`

Returns the session user's effective workspace role and UI capabilities, secure lifetime defaults/maxima, quotas, and legacy migration notice.

```json
{
  "effectiveRole": "member | admin | owner",
  "capabilities": {
    "manageOwnPersonalTokens": true,
    "auditWorkspacePersonalTokens": false,
    "manageServiceAccounts": false
  },
  "defaults": {
    "personalTokenLifetimeDays": 90,
    "serviceCredentialLifetimeDays": 365
  },
  "limits": {
    "personalTokensPerUser": 10,
    "serviceAccountsPerWorkspace": 50,
    "credentialsPerServiceAccount": 5,
    "maximumPageSize": 100
  },
  "legacyCredentialMigration": {
    "status": "destroyed | not_applicable",
    "migratedAt": "RFC3339 UTC | null"
  }
}
```

## Personal token endpoints

### `GET /api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens`

Query:

- `view=mine` (default): any workspace member; returns only the session user's credentials.
- `view=workspace`: administrator/owner only; returns safe metadata for all personal credentials.
- `page`, `limit` as defined above.

### `POST /api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens`

Any workspace user creates a personal token only for themself.

Request:

```json
{
  "label": "CLI on laptop",
  "roleCeiling": "member | admin",
  "expiresAt": "RFC3339 UTC"
}
```

- Requested ceiling cannot exceed current effective role; owner is capped to administrator.
- Expiry is future and no later than 90 days or a stricter workspace maximum.
- Returns `201` with the one-time credential response.

### `PATCH /api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}`

Owner-only relabel.

```json
{ "label": "Renamed label", "revision": 3 }
```

Returns updated safe metadata. A stale revision returns `409`.

### `POST /api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}/rotate`

Owner-only immediate rotation.

```json
{ "revision": 3 }
```

Returns `201` with one replacement secret. The predecessor is revoked atomically; absolute expiry and principal binding are unchanged. A stale/racing request returns `409` and no secret.

### `POST /api/v1/account/workspaces/{workspaceId}/api-access/personal-tokens/{credentialId}/revoke`

- Owner may revoke their credential.
- Administrator/owner may revoke another user's credential.
- Repeating revoke is idempotent and returns current safe metadata.
- No reveal, relabel, or rotation is available to another user.

## Service account endpoints

All endpoints in this section require an administrator/owner session.

### `GET /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts`

Returns paginated service-account summaries with aggregate last use and active credential count.

### `POST /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts`

Creates one service account and its first credential atomically.

```json
{
  "displayName": "Nightly ingestion",
  "role": "member | admin",
  "credentialExpiresAt": "RFC3339 UTC"
}
```

The assigned role cannot exceed the acting user's effective role. The server labels the first credential `Primary`; callers label only additional credentials once that distinction is useful. Returns `201`:

```json
{
  "serviceAccount": { "...": "service account detail" },
  "credential": { "...": "credential metadata" },
  "secret": "radioso_svc_<opaque-value>"
}
```

### `GET /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}`

Returns safe service-account detail:

```json
{
  "id": "uuid",
  "displayName": "Nightly ingestion",
  "role": "member | admin",
  "status": "enabled | disabled | archived",
  "createdByUserId": "uuid",
  "createdAt": "RFC3339 UTC",
  "updatedAt": "RFC3339 UTC",
  "lastUsedAt": "RFC3339 UTC | null",
  "activeCredentialCount": 2,
  "revision": 4
}
```

### `PATCH /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}`

Renames and/or changes live role.

```json
{
  "displayName": "Optional new name",
  "role": "member | admin",
  "revision": 4
}
```

At least one mutable field is required. Role cannot exceed the acting user's role. Archived accounts reject changes. A role change affects every credential on its next request.

### `POST .../service-accounts/{serviceAccountId}/disable`

### `POST .../service-accounts/{serviceAccountId}/enable`

### `POST .../service-accounts/{serviceAccountId}/archive`

Each accepts `{ "revision": 4 }` and returns updated safe detail.

- Disable suspends all otherwise-active credentials.
- Enable restores only unexpired/unrevoked credentials.
- Archive is permanent and atomically revokes all child credentials.
- Invalid or stale transitions return `409`.

## Service credential endpoints

### `GET /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}/credentials`

Returns paginated safe credential metadata. No secret is recoverable.

### `POST /api/v1/account/workspaces/{workspaceId}/api-access/service-accounts/{serviceAccountId}/credentials`

Issues an additional credential for zero-downtime deployment.

```json
{
  "label": "Canary runner",
  "expiresAt": "RFC3339 UTC"
}
```

Returns `201` with one-time credential response. Disabled or archived accounts reject issuance. Five active credentials is the hard maximum.

### `PATCH .../service-accounts/{serviceAccountId}/credentials/{credentialId}`

Relabels one credential with `{ "label": "New label", "revision": 2 }`.

### `POST .../service-accounts/{serviceAccountId}/credentials/{credentialId}/rotate`

Immediately rotates one credential with `{ "revision": 2 }`. Returns one replacement secret; absolute expiry and service-principal binding are unchanged.

### `POST .../service-accounts/{serviceAccountId}/credentials/{credentialId}/revoke`

Idempotently revokes only the selected credential. Sibling credentials remain active.

## Ordinary API authentication

Eligible workspace API operations continue accepting:

```http
Authorization: Bearer <personal-or-service-credential>
```

- Personal principal: effective role is the lower of declared ceiling and live user role for the bound membership tenure.
- Service principal: effective role is the live enabled service-account role.
- Route coverage policy may still require an interactive session.
- A valid interactive session keeps precedence over bearer auth when both are present on an ordinary workspace route.

## Agent channel credential endpoints

All lifecycle endpoints require an interactive session plus the centralized agent-management permission. A personal token, service credential, public-launch token, or agent credential never satisfies these endpoints.

### Shared metadata

```json
{
  "id": "uuid",
  "audience": "mcp | rest",
  "label": "Customer support client",
  "prefix": "radioso_<safe-prefix>",
  "status": "active | expired | revoked | disabled",
  "createdAt": "RFC3339 UTC",
  "expiresAt": "RFC3339 UTC",
  "lastUsedAt": "RFC3339 UTC | null",
  "revokedAt": "RFC3339 UTC | null"
}
```

Metadata contains no role because a channel credential is not a workspace principal.

### `GET /api/v1/agents/{agentId}/channel-credentials`

Optional query `audience=mcp|rest` filters the safe inventory. The path agent must belong to the active workspace.

### `POST /api/v1/agents/{agentId}/channel-credentials`

```json
{
  "audience": "mcp | rest",
  "label": "Customer support client",
  "expiresAt": "RFC3339 UTC"
}
```

Returns `201`:

```json
{
  "credential": { "...": "agent channel credential metadata" },
  "secret": "<opaque one-time secret>"
}
```

The secret is retained only as a hash verifier and appears in no later response.

### `POST /api/v1/agents/{agentId}/channel-credentials/{credentialId}/rotate`

Immediately replaces the verifier and returns one replacement secret with the same agent, workspace, audience, label, and absolute expiry. Existing derived MCP sessions fail their next validation.

### `POST /api/v1/agents/{agentId}/channel-credentials/{credentialId}/revoke`

Idempotently revokes the selected channel credential. A credential belonging to another agent returns `404` without revealing the binding.

## REST agent chat

### `POST /api/v1/agents/{agentId}/chat`

Authentication is exclusively:

```http
Authorization: Bearer <rest-agent-credential>
```

Request:

```json
{
  "message": "How can I reset my password?",
  "conversationId": "uuid (optional resume)",
  "startConversation": false,
  "stream": false,
  "userExpectedLocale": "en (optional)"
}
```

- `message` is required unless `startConversation` is true.
- `startConversation` cannot include `conversationId` and cannot stream.
- `conversationId` may resume only a conversation already bound to this workspace and agent.
- The path `agentId` must equal the credential's immutable binding; the route never resolves the workspace default agent and accepts no body `agentId`.
- Responses reuse the assistant chat JSON/SSE contract without debug/operator-only fields.
- Interactive sessions, personal/service credentials, MCP credentials, and public-launch credentials are rejected with the generic channel-credential `401`.

## MCP agent chat

- MCP exchange accepts only an active `mcp`-audience channel credential bound to one agent. It rejects personal, service, REST-agent, and public-launch credentials without token-shape classification.
- A short-lived MCP session revalidates the underlying grant ID, version, audience, workspace/agent binding, enabled state, expiry, rotation, and revocation before each operation.
- The MCP catalogue for this principal contains only `ask_agent`, which runs the stateful agent turn loop.
- `answer_grounded`, direct resource listing/reading, workspace document tools, write tools, Ray/operator tools, and skill-catalogue management are absent.
- All paths use generic invalid-credential/session responses.
- OAuth is not required for operator-minted credentials; delegated OAuth installation remains out of scope.

## Route-policy capabilities

The account access policy adds session capabilities with role mappings:

| Capability | Member | Admin | Owner |
|---|---:|---:|---:|
| `workspace.api_access.personal.manage_self` | yes | yes | yes |
| `workspace.api_access.personal.audit` | no | yes | yes |
| `workspace.api_access.service.manage` | no | yes | yes |
| Existing centralized agent-management permission (channel lifecycle) | policy-defined | yes | yes |

Machine principals are denied all lifecycle capabilities through the HTTP route policy even if their effective role is administrator. Agent channel credentials bypass neither this table nor ordinary route policy; they are consumed only by the dedicated agent-chat transport.

## Message-queue impact

Document-worker dispatch, AMQP payload shapes, retry semantics, queue tests, and queue documentation are unaffected. Credentials terminate at HTTP/MCP authentication boundaries, and both transports call the existing synchronous chat service. Expiry warnings use an application lifecycle hook and do not create a worker message contract.

## Ray coverage

All API-access and agent-channel credential lifecycle operation IDs receive a permanent Operator Copilot coverage-map exclusion because identity, access, and secret management are on Ray's never-list. The REST agent chat operation is a runtime channel rather than an operator action and is also excluded from Ray's management catalogue.
