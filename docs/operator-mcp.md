---
title: "Operator MCP OAuth Access"
description: "Connect an OAuth-capable MCP client to Ray's governed workspace tools and manage its access."
last_updated: 2026-09-04
---

# Operator MCP OAuth Access

Operator MCP lets a signed-in workspace member use a compatible remote MCP client to inspect settings, run a retrieval probe, or draft an ingestion-settings proposal. You choose the workspace and scopes in Radioso before the client receives a credential. Each tool call rechecks the user, membership, grant, client, and current workspace permission.

This is separate from an agent's **Channels → MCP** connection. The agent connection exposes `ask_agent` for one configured agent. Operator MCP exposes a small set of Ray tools for the person who completed OAuth consent.

## Connect from the dashboard

1. Open **Settings → API access** and find **Operator MCP**.
2. Choose a client. A named client is selectable only when its exact build has a captured discovery, callback, list, call, refresh, and revoke transcript. The generic option shows the canonical remote HTTP URL for clients that implement the same OAuth profile.
3. Add that URL to the MCP client. The client opens Radioso in your browser.
4. Review the client identity, redirect host, workspace, requested scopes, and offline-access request. Approve only what the client needs.
5. Return to **Settings → API access** to inspect or revoke the grant. Revocation invalidates its access and refresh lineage on the next request.

The setup page currently marks the recorded Codex CLI, Claude Code, and ChatGPT developer-mode profiles unavailable because their exact builds do not have complete compatibility evidence. The generic setup path is labelled unverified and should be used only with a client whose remote HTTP OAuth behavior you can inspect.

## Tool boundary

The catalog is rebuilt from the caller's current permissions for every list or call. It contains only these eligible descriptors:

- `workspace_settings` requires `operator:read`.
- `retrieval_probe` requires `operator:probe`.
- `propose_ingestion_settings` requires `operator:propose` and an operation id so a lost response can be reconciled without duplicating a proposal.

The `operator:act` scope is part of the authorization vocabulary, but this rollout admits no act descriptor. Queue-backed reprocessing, recrawling, replies, credential administration, and provider authorization are outside this catalog.

## OAuth profile

Operator MCP uses an authorization-code flow with S256 PKCE, an exact RFC 8707 resource value, immutable client metadata snapshots, and public clients. Access credentials last at most 15 minutes. Refresh access is shown separately in consent and can only narrow the approved tool scopes.

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

For Terraform-managed Cloud Run, keep the existing agent MCP deployment switch and the Operator MCP switch distinct:

```hcl
radioso_mcp_enabled          = true
operator_mcp_enabled         = true
operator_mcp_public_origin   = "https://mcp.example.com"
operator_mcp_credential_epoch = "1"
```

Terraform generates one `OPERATOR_MCP_INTERNAL_SECRET`, injects the exact same bytes into the backend and standalone service, and exports `operator_mcp_resource_url`. It also sends that URL to the dashboard as `RADIOSO_OPERATOR_MCP_PUBLIC_URL`.

For a manual deployment, configure both processes with the same values:

```dotenv
OPERATOR_MCP_ENABLED=true
OPERATOR_MCP_RESOURCE_URL=https://mcp.example.com/operator/mcp
OPERATOR_MCP_ISSUER_URL=https://app.example.com
OPERATOR_MCP_INTERNAL_SECRET=<at least 32 random characters>
OPERATOR_MCP_CREDENTIAL_EPOCH=1
```

Production resource and issuer URLs must use HTTPS. Local development may use HTTP only on a loopback host.

## Rotate or restore credentials

`OPERATOR_MCP_CREDENTIAL_EPOCH` is an external monotonic generation, not data recovered from a database backup. All enabled backend replicas and the standalone service must use the same epoch and internal-secret fingerprint.

To rotate the internal secret or restore an older database:

1. Choose an epoch greater than every epoch used by the deployment.
2. With `DATABASE_URL`, `OPERATOR_MCP_RESOURCE_URL`, the new `OPERATOR_MCP_INTERNAL_SECRET`, and the new `OPERATOR_MCP_CREDENTIAL_EPOCH` loaded, set `OPERATOR_MCP_PREVIOUS_CREDENTIAL_EPOCH` to the current persisted epoch and run `pnpm --dir backend run operator-mcp:rotate-credential-state` once.
3. Deploy every enabled replica with the same new secret and epoch.
4. Check readiness before routing traffic.

Startup never advances a persisted epoch. A replica with an older epoch, a newer unpersisted epoch, or a different fingerprint at the same epoch stays unready. This makes an old database plus an old key insufficient to revive credentials after a restore.

## Failure recovery

- **Client is unavailable:** use only a build with complete evidence, or inspect the generic client's OAuth behavior before connecting it.
- **Audience mismatch:** copy the canonical URL from **Settings → API access** without adding a slash, query, or fragment.
- **Consent expired or account changed:** restart the connection from the client so Radioso creates a new browser-bound transaction.
- **Permission or membership changed:** restore the required workspace access, then reconnect if the grant was revoked.
- **Credential epoch mismatch:** complete the explicit rotation step and deploy the same epoch and secret to every replica.

## Read next

- [MCP client setup](./mcp-client-setup.md) for the separate one-agent `ask_agent` connection.
- [MCP server package](../packages/radioso-mcp-server/README.md) for runtime configuration and checks.
