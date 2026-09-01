---
title: "API Access Credential Upgrade"
description: "How to prepare API clients for the destructive replacement of shared workspace tokens with personal tokens and service-account credentials."
last_updated: 2026-08-31
---

# API Access Credential Upgrade

This database upgrade destroys the shared workspace API token for every workspace. Its ciphertext and verifier are removed, so existing API clients stop authenticating as soon as the upgrade completes. API-token-backed MCP sessions also stop working, and MCP runtime stores controlled by the installation purge their stored copies before reporting ready.

There is no overlap period. Prepare a maintenance window for API integrations that must keep running.

## Before the upgrade

1. Inventory every REST API integration that uses a shared workspace token.
2. Record which workspace and effective role each integration needs. Do not copy the existing secret into the inventory.
3. Take a database backup that is compatible with the application version you are replacing, and verify its restore procedure.
4. Schedule time after the deployment for an owner or administrator to sign in and issue replacement credentials.

The previous application version cannot run safely against the upgraded database. Downgrading requires restoring the compatible backup.

## After the upgrade

Choose a personal token for automation that should stop when its user loses workspace access. Choose a service account for CI, services, and scheduled jobs that need a durable non-human identity.

For each client:

1. Sign in to the dashboard and open **Settings → API access**.
2. Create the personal token or service account and credential with the narrowest suitable role.
3. Choose an expiry if the client should stop automatically, and copy the secret from the one-time response into the client's secret manager.
4. Verify the client against an eligible REST API route.
5. Record the credential ID and safe prefix in your operational inventory, not the secret itself.

Personal tokens and service-account credentials are rejected by all MCP endpoints. Agent converse continues to use its separate grant and session credential flow. Workspace-document MCP clients that relied on the removed shared token cannot be reconfigured with the new REST credentials.

## Failure recovery

If the deployment fails before the database migration commits, fix the failure and retry; the migration is transactional and idempotent. If it completes and an issuance response is then lost, use the safe inventory entry to rotate or revoke that credential. Radioso never stores a recoverable copy.

If you must return to the previous application version, stop the upgraded services and restore the compatible pre-upgrade database backup. Restoring application binaries alone cannot restore destroyed credentials.
