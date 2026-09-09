---
title: "Operator MCP OAuth Access"
description: "Connect an OAuth-capable MCP client to Ray's governed workspace tools and manage its access."
last_updated: 2026-09-07
---

# Operator MCP OAuth Access

Operator MCP lets a signed-in workspace member use a compatible remote MCP client to inspect settings, run a retrieval probe, or draft an ingestion-settings proposal. You choose the workspace and scopes in Radioso before the client receives a credential. Each tool call rechecks the user, membership, grant, client, and current workspace permission.

This is separate from an agent's **Channels → MCP** connection. The agent connection exposes `ask_agent` for one configured agent. Operator MCP exposes a small set of Ray tools for the person who completed OAuth consent.

## Connect from the dashboard

1. Open **Settings → API access** and find **Operator MCP**.
2. Choose the **Codex**, **Claude**, **Cursor**, or **Other** tab and copy the setup it shows. The command or configuration includes the canonical Operator MCP URL for this deployment.
3. Paste it into the client and complete the browser sign-in when it asks.
4. Choose the workspace and requested scopes, then approve the connection. If the client requests refresh access, it stays connected until that access expires or you revoke the grant.
5. Return to **Settings → API access** to inspect or revoke the grant. Revocation invalidates its access and refresh lineage on the next request.

The setup snippets are labelled **Not verified** until Radioso has captured a full compatibility transcript for that client build. They contain no credential; a successful connection still requires the client's OAuth flow to complete.

## Tool boundary

The catalog is rebuilt from the caller's current permissions for every list or call, and every production Ray descriptor carries a reviewed disposition: eligible with a scope and retry contract, or excluded with a stated reason. It currently admits:

- **Reads** (`operator:read`) — `workspace_settings`, `agent_configuration`, `agent_skills`, `context_variables`, `conversation_history_search`, `conversation_transcript`, `document_chunks`, `document_search`, `document_status`, `eval_results`, `quality_signals`, `routine_definition`, `turn_trace`, `validate_routine`, `workspace_triage`.
- **Probes** (`operator:probe`) — `retrieval_probe`.
- **Proposals** (`operator:propose`) — `propose_ingestion_settings`, `propose_agent_setting`, `propose_context_variable`, `propose_directive`, `propose_directive_enablement`, `propose_directive_removal`, `propose_routine`, `propose_routine_edit`, `propose_routine_lifecycle`, `propose_skill_config`. Each requires an operation id: a lost response is reconciled from the proposal it already created rather than duplicating it.
- **Acts** (`operator:act`) — `set_triage_state`, admitted because it is fenced by an expected version rather than appended: a lost-response retry either lands the transition once or comes back a conflict against whatever won, never a duplicate effect.

Queue-backed reprocessing, recrawling, eval-suite runs, customer replies, credential administration, and provider authorization stay outside this catalog — each either has no owner-approved retry contract yet or depends on dashboard/Ray-conversation context the stateless transport does not provide.

## OAuth profile

Operator MCP uses an authorization-code flow with S256 PKCE, an exact RFC 8707 resource value, RFC 9207 issuer binding on authorization responses, immutable client metadata snapshots, and public clients. Access credentials last at most 15 minutes. When a client requests refresh access, approving the connection includes it; refresh access can only narrow the approved tool scopes. The resource supports Radioso's stateless `2026-07-28` profile and a standard `2025-06-18` initialize/list/call compatibility path; both use the same authorization, catalog, rate-limit, proof, and audit boundaries.

The standalone protected resource is:

```text
https://mcp.example.com/operator/mcp
```

Its metadata is published at:

```text
https://mcp.example.com/.well-known/oauth-protected-resource/operator/mcp
```

Authorization-server metadata comes from the configured Radioso issuer at `/.well-known/oauth-authorization-server`. The resource URL is byte-for-byte significant; a trailing slash is a different audience and is rejected.

## Deployment

For Terraform-managed Cloud Run, turn on the existing standalone MCP service. Its `/mcp` and `/operator/mcp` routes stay separate, but the same service deployment supplies both.

```hcl
radioso_mcp_enabled = true
```

The GitHub Terraform workflow discovers the Cloud Run MCP URL and uses it for both MCP routes. Set `MCP_PUBLIC_ORIGIN` only when the MCP service is served from a custom domain. Terraform generates one `OPERATOR_MCP_INTERNAL_SECRET`, injects the exact same bytes into the backend and standalone service, and exports `operator_mcp_resource_url`. It also sends that URL to the dashboard as `RADIOSO_OPERATOR_MCP_PUBLIC_URL`.

The Cloud Run URL exists after the standalone MCP service has been created. When bootstrapping a deployment, run Terraform once to create the service, then run it again; the workflow discovers the new URL and configures Operator MCP automatically. A direct Terraform run needs `mcp_public_origin` set to the Cloud Run URL or custom domain after the service exists.

For a manual deployment, configure both processes with the same values:

```dotenv
OPERATOR_MCP_RESOURCE_URL=https://mcp.example.com/operator/mcp
OPERATOR_MCP_ISSUER_URL=https://app.example.com
OPERATOR_MCP_INTERNAL_SECRET=<at least 32 random characters>
OPERATOR_MCP_CREDENTIAL_EPOCH=1
```

Production resource and issuer URLs must use HTTPS. Local development may use HTTP only on a loopback host.

## Rotate or restore credentials

`OPERATOR_MCP_CREDENTIAL_EPOCH` is an external monotonic generation, not data recovered from a database backup. All enabled backend replicas and the standalone service must use the same epoch and internal-secret fingerprint.

Operator MCP starts when its resource URL, issuer URL, internal secret, and credential epoch are all configured in both processes. It is available to every workspace; there is no deployment allowlist. The verification budget stays capped at six operations per credential each minute.

Deployment availability does not grant a client access. Each connection still needs browser OAuth consent, an active membership in the selected workspace, approved scopes, and the canonical resource URL. Every tool request rechecks the grant, client, membership, scopes, and current permissions; it remains subject to source and principal rate limits and is recorded in audit logs.

To rotate the internal secret or restore an older database:

1. Choose an epoch greater than every epoch used by the deployment.
2. With `DATABASE_URL`, `OPERATOR_MCP_RESOURCE_URL`, the new `OPERATOR_MCP_INTERNAL_SECRET`, and the new `OPERATOR_MCP_CREDENTIAL_EPOCH` loaded, set `OPERATOR_MCP_PREVIOUS_CREDENTIAL_EPOCH` to the current persisted epoch and run `pnpm --dir backend run operator-mcp:rotate-credential-state` once.
3. Deploy every enabled replica with the same new secret and epoch.
4. Check readiness before routing traffic.

Startup never advances a persisted epoch. A replica with an older epoch, a newer unpersisted epoch, or a different fingerprint at the same epoch stays unready. This makes an old database plus an old key insufficient to revive credentials after a restore.

## Failure recovery

- **Client rejects the setup:** confirm that it supports remote HTTP MCP with OAuth, remove the server from the client, and add it again from the dashboard.
- **Audience mismatch:** copy the canonical URL from **Settings → API access** without adding a slash, query, or fragment.
- **Consent expired or account changed:** restart the connection from the client so Radioso creates a new browser-bound transaction.
- **Permission or membership changed:** restore the required workspace access, then reconnect if the grant was revoked.
- **Credential epoch mismatch:** complete the explicit rotation step and deploy the same epoch and secret to every replica.

## Read next

- [MCP client setup](./mcp-client-setup.md) for the separate one-agent `ask_agent` connection.
- [MCP server package](../packages/radioso-mcp-server/README.md) for runtime configuration and checks.
