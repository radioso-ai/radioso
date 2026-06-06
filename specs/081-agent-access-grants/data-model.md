# Agent Access Grants Data Model

## `agent_access_grants`

Columns:

- `id UUID PRIMARY KEY`
- `agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE`
- `workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`
- `label TEXT NULL`
- `principal_kind TEXT NOT NULL CHECK (principal_kind IN ('workspace-admin', 'agent-api', 'public-launch'))`
- `role TEXT NOT NULL CHECK (role IN ('public'))`
- `token_prefix TEXT NOT NULL`
- `token_hash TEXT NOT NULL`
- `encrypted_token TEXT NOT NULL`
- `origin_mode TEXT NOT NULL CHECK (origin_mode IN ('allow-all', 'list'))`
- `origin_allowlist TEXT[] NOT NULL DEFAULT ARRAY[]::text[]`
- `enabled BOOLEAN NOT NULL DEFAULT true`
- `expires_at TIMESTAMPTZ NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `last_used_at TIMESTAMPTZ NULL`
- `revoked_at TIMESTAMPTZ NULL`

Indexes:

- Unique `token_hash` for hash lookup and collision prevention.
- `agent_id` for future management/list views.
- `workspace_id` for workspace cleanup and support/debug queries.
- Partial active hash index is not needed in addition to unique `token_hash` for MVP lookup; revoked grants remain findable by hash so auth failures can distinguish `revoked` from unknown-token without exposing that distinction to callers.

## Domain shape

`AccessGrant` is bound to exactly one agent and workspace. The credential lifecycle fields are independent of surface settings. Public launch grants use `principalKind = 'public-launch'` and `role = 'public'`; future bearer grants will use `agent-api`; the existing workspace admin token remains in `workspace_tokens` and is not migrated into this table.

`OriginConstraint`:

```ts
type OriginConstraint =
  | { mode: "allow-all"; origins: [] }
  | { mode: "list"; origins: string[] };
```

`mode: "list"` with `origins: []` means allow-none.

## Authorization

For US1, public launch grants remain credentials only. `resolveAnonymousSession` validates grant credential state and origin, then continues to authorize requests through the existing public session principal:

```ts
{
  type: "public_chat_session";
  role: "public";
  workspaceId: string;
  agentId?: string | null;
  publicSessionId: string;
}
```

`AccountAccessService` remains the only allow/deny decider. The `public` role resolves to the existing `PUBLIC_CHAT_PERMISSIONS` set. Bearer-lane resolution for `agent-api` grants is intentionally deferred to US2/US4.
