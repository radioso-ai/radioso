import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OperatorMcpAuthorizationRepository } from "../../../src/db/repositories/operatorMcpAuthorizationRepository.js";
import { Database } from "../../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "../support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("OperatorMcpAuthorizationRepository", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new OperatorMcpAuthorizationRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const clientRecordId = randomUUID();
  const clientId = `https://client.example/${clientRecordId}`;
  const snapshotId = randomUUID();
  const grantId = randomUUID();
  const credentialId = randomUUID();
  const sessionId = randomUUID();
  const resource = "https://mcp.example/operator/mcp";
  const tokenDigest = createHash("sha256").update(randomUUID()).digest("base64url");

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, 'Operator MCP', $2, 'hash')", [accountId, `operator-${accountId}@example.com`]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [userId, `operator-user-${userId}@example.com`]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, accountId, userId]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Operator', $3)", [workspaceId, accountId, `operator-${workspaceId}`]);
    await database.query(
      "INSERT INTO sessions (id, account_id, user_id, session_token_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 hour')",
      [sessionId, accountId, userId, `session-${sessionId}`],
    );
    await database.query(
      `INSERT INTO operator_mcp_clients
        (id, client_id, registration_method, application_type, display_name, redirect_uris, metadata_digest)
       VALUES ($1, $2, 'metadata_document', 'native', 'Test client', '[]'::jsonb, $3)`,
      [clientRecordId, clientId, "metadata-digest"],
    );
    await database.query(
      `INSERT INTO operator_mcp_client_metadata_snapshots
        (id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at)
       VALUES ($1, $2, 1, $3, '{}'::jsonb, 'metadata_document', NOW())`,
      [snapshotId, clientRecordId, "metadata-digest"],
    );
    await database.query(
      `INSERT INTO operator_mcp_grants
        (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id,
         membership_id, resource, tool_scopes, offline_access, credential_epoch)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:read'], false, 7)`,
      [grantId, clientRecordId, snapshotId, accountId, workspaceId, userId, membershipId, resource],
    );
    await database.query(
      `INSERT INTO operator_mcp_access_credentials
        (id, grant_id, token_digest, issued_grant_version, issued_client_version,
         issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
         issued_offline_access, expires_at)
       VALUES ($1, $2, $3, 1, 1, $4, 7, ARRAY['operator:read'], false, NOW() + INTERVAL '15 minutes')`,
      [credentialId, grantId, tokenDigest, snapshotId],
    );
  });

  afterAll(async () => {
    await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_client_metadata_snapshots WHERE client_id = $1", [clientRecordId]).catch(() => undefined);
    await database.query("DELETE FROM operator_mcp_clients WHERE id = $1", [clientRecordId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  it("returns exact credential ceilings with current grant/client/membership/user state", async () => {
    await expect(repository.findCurrentCredential({ tokenDigest, resource, now: new Date() })).resolves.toMatchObject({
      credential: {
        id: credentialId,
        issuedCredentialEpoch: "7",
        issuedToolScopes: ["operator:read"],
      },
      grant: { id: grantId, membershipId, toolScopes: ["operator:read"] },
      clientStatus: "active",
      membershipStatus: "active",
      membershipRole: "admin",
      userDisabledAt: null,
    });
    await expect(repository.findCurrentCredential({ tokenDigest, resource: `${resource}/`, now: new Date() })).resolves.toBeNull();
  });

  it("fails closed for disabled users and revoked grants", async () => {
    await database.query("UPDATE users SET disabled_at = NOW() WHERE id = $1", [userId]);
    await expect(repository.findCurrentCredential({ tokenDigest, resource, now: new Date() })).resolves.toMatchObject({ userDisabledAt: expect.any(Date) });
    await database.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [userId]);
    await expect(repository.revokeGrant({ grantId, reason: "explicit", now: new Date() })).resolves.toBe(true);
    await expect(repository.findCurrentCredential({ tokenDigest, resource, now: new Date() })).resolves.toBeNull();
  });

  it("accepts only monotonic external epoch/key state and rejects mixed replicas", async () => {
    const epochResource = `https://mcp.example/operator/mcp?test=${randomUUID()}`;
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "7", keyFingerprint: "key-a", now: new Date() })).resolves.toBe("initialized");
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "7", keyFingerprint: "key-a", now: new Date() })).resolves.toBe("current");
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "7", keyFingerprint: "key-b", now: new Date() })).rejects.toThrow(/fingerprint/i);
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "8", keyFingerprint: "key-b", now: new Date() })).rejects.toThrow(/explicit rotation/i);
    await expect(repository.advanceDeploymentCredentialState({ resource: epochResource, currentCredentialEpoch: "7", credentialEpoch: "8", keyFingerprint: "key-b", now: new Date() })).resolves.toBe(true);
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "8", keyFingerprint: "key-b", now: new Date() })).resolves.toBe("current");
    await expect(repository.ensureDeploymentCredentialState({ resource: epochResource, credentialEpoch: "7", keyFingerprint: "key-a", now: new Date() })).rejects.toThrow(/epoch/i);
  });

  it("initializes one deployment credential row safely across concurrent replicas", async () => {
    const epochResource = `https://mcp.example/operator/mcp?concurrent=${randomUUID()}`;
    const suffix = randomUUID().replaceAll("-", "_");
    const functionName = `test_operator_mcp_init_${suffix}`;
    const triggerName = `test_operator_mcp_init_trigger_${suffix}`;
    const advisoryKey = 1_148_166;
    const input = {
      resource: epochResource,
      credentialEpoch: "13",
      keyFingerprint: "shared-key",
      now: new Date(),
    };
    const lockClient = await database.pool.connect();
    try {
      await database.query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.resource = TG_ARGV[0] THEN
            PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await database.query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON operator_mcp_deployment_credential_state
        FOR EACH ROW EXECUTE FUNCTION ${functionName}('${epochResource}', '${advisoryKey}')
      `);
      await lockClient.query("SELECT pg_advisory_lock($1)", [advisoryKey]);
      const attempts = [
        repository.ensureDeploymentCredentialState(input),
        repository.ensureDeploymentCredentialState(input),
      ];
      for (let poll = 0; poll < 100; poll += 1) {
        const waiting = await database.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
          FROM pg_stat_activity
          WHERE wait_event = 'advisory'
            AND query LIKE '%INSERT INTO operator_mcp_deployment_credential_state%'
        `);
        if (Number(waiting[0]?.count ?? 0) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await lockClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]);
      const outcomes = await Promise.all(attempts);
      expect(outcomes).toEqual(expect.arrayContaining(["initialized", "current"]));
      await expect(database.query(
        "SELECT resource FROM operator_mcp_deployment_credential_state WHERE resource = $1",
        [epochResource],
      )).resolves.toHaveLength(1);
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [advisoryKey]).catch(() => undefined);
      lockClient.release();
      await database.query(`DROP TRIGGER IF EXISTS ${triggerName} ON operator_mcp_deployment_credential_state`).catch(() => undefined);
      await database.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
    }
  });

  it("projects an elapsed pending transaction as expired for the consent surface", async () => {
    const transactionId = randomUUID();
    const testNow = new Date();
    await repository.createTransaction({
      id: transactionId,
      clientRecordId,
      clientMetadataSnapshotId: snapshotId,
      clientMetadataDigest: "metadata-digest",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "opaque-state",
      codeChallenge: "challenge",
      resource,
      requestedToolScopes: ["operator:read"],
      requestedOfflineAccess: false,
      expiresAt: new Date(testNow.getTime() - 1),
      createdAt: new Date(testNow.getTime() - 301_000),
    });
    await expect(repository.findTransaction(transactionId, testNow)).resolves.toMatchObject({ status: "expired" });
  });

  it("atomically binds consent, exchanges a code, narrows scopes, and invalidates refresh successors on replay", async () => {
    const transactionId = randomUUID();
    const authorizationCodeDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const firstAccessId = randomUUID();
    const firstAccessDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const firstRefreshDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const lineageId = randomUUID();
    const testNow = new Date();
    await repository.createTransaction({
      id: transactionId,
      clientRecordId,
      clientMetadataSnapshotId: snapshotId,
      clientMetadataDigest: "metadata-digest",
      redirectUri: "http://127.0.0.1:43123/callback",
      state: "opaque-state",
      codeChallenge: "challenge",
      resource,
      requestedToolScopes: ["operator:read", "operator:probe"],
      requestedOfflineAccess: true,
      expiresAt: new Date(testNow.getTime() + 300_000),
      createdAt: testNow,
    });
    await expect(repository.decideTransaction({
      transactionId, sessionId, accountId, userId, workspaceId, membershipId,
      approvedToolScopes: ["operator:read", "operator:probe"], approvedOfflineAccess: true,
      authorizationCodeDigest, status: "approved", now: testNow,
    })).resolves.toBe(true);

    const exchanged = await repository.exchangeAuthorizationCode({
      authorizationCodeDigest, clientId, redirectUri: "http://127.0.0.1:43123/callback",
      resource, codeChallenge: "challenge", requestedToolScopes: ["operator:read"], credentialEpoch: "7",
      accessCredential: { id: firstAccessId, tokenDigest: firstAccessDigest, expiresAt: new Date(testNow.getTime() + 900_000) },
      refreshCredential: {
        lineageId, tokenDigest: firstRefreshDigest,
        idleExpiresAt: new Date(testNow.getTime() + 86_400_000), absoluteExpiresAt: new Date(testNow.getTime() + 172_800_000),
      },
      now: testNow,
    });
    expect(exchanged).toMatchObject({ toolScopes: ["operator:read"], offlineAccess: true });
    await expect(repository.exchangeAuthorizationCode({
      authorizationCodeDigest, clientId, redirectUri: "http://127.0.0.1:43123/callback", resource,
      codeChallenge: "challenge", credentialEpoch: "7",
      accessCredential: { id: randomUUID(), tokenDigest: randomUUID(), expiresAt: new Date(testNow.getTime() + 900_000) },
      refreshCredential: null, now: testNow,
    })).resolves.toBeNull();

    const successorAccessDigest = createHash("sha256").update(randomUUID()).digest("hex");
    const successorRefreshDigest = createHash("sha256").update(randomUUID()).digest("hex");
    await expect(repository.rotateRefreshCredential({
      tokenDigest: firstRefreshDigest, clientId, resource, credentialEpoch: "7",
      accessCredential: { id: randomUUID(), tokenDigest: successorAccessDigest, expiresAt: new Date(testNow.getTime() + 900_000) },
      successorTokenDigest: successorRefreshDigest, idleExpiresAt: new Date(testNow.getTime() + 86_400_000), now: testNow,
    })).resolves.toMatchObject({ status: "rotated", toolScopes: ["operator:read"] });
    await expect(repository.findCurrentCredential({ tokenDigest: successorAccessDigest, resource, now: testNow })).resolves.not.toBeNull();
    await expect(repository.rotateRefreshCredential({
      tokenDigest: firstRefreshDigest, clientId, resource, credentialEpoch: "7",
      accessCredential: { id: randomUUID(), tokenDigest: randomUUID(), expiresAt: new Date(testNow.getTime() + 900_000) },
      successorTokenDigest: randomUUID(), idleExpiresAt: new Date(testNow.getTime() + 86_400_000), now: testNow,
    })).resolves.toMatchObject({ status: "replay" });
    await expect(repository.findCurrentCredential({ tokenDigest: successorAccessDigest, resource, now: testNow })).resolves.toBeNull();
    await expect(repository.rotateRefreshCredential({
      tokenDigest: successorRefreshDigest, clientId, resource, credentialEpoch: "7",
      accessCredential: { id: randomUUID(), tokenDigest: randomUUID(), expiresAt: new Date(testNow.getTime() + 900_000) },
      successorTokenDigest: randomUUID(), idleExpiresAt: new Date(testNow.getTime() + 86_400_000), now: testNow,
    })).resolves.toMatchObject({ status: "invalid" });
  });

  it("revokes every grant and credential for one client record", async () => {
    const grants = [randomUUID(), randomUUID()];
    const workspaces = [randomUUID(), randomUUID()];
    const digests = [randomUUID(), randomUUID()].map((value) => createHash("sha256").update(value).digest("base64url"));
    for (const [index, nextGrantId] of grants.entries()) {
      await database.query(
        "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, 'Operator client revoke', $3)",
        [workspaces[index], accountId, `operator-client-revoke-${workspaces[index]}`],
      );
      await database.query(
        `INSERT INTO operator_mcp_grants
          (id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id, user_id,
           membership_id, resource, tool_scopes, offline_access, credential_epoch)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, ARRAY['operator:read'], false, 7)`,
        [nextGrantId, clientRecordId, snapshotId, accountId, workspaces[index], userId, membershipId, resource],
      );
      await database.query(
        `INSERT INTO operator_mcp_access_credentials
          (id, grant_id, token_digest, issued_grant_version, issued_client_version,
           issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
           issued_offline_access, expires_at)
         VALUES ($1, $2, $3, 1, 1, $4, 7, ARRAY['operator:read'], false, NOW() + INTERVAL '15 minutes')`,
        [randomUUID(), nextGrantId, digests[index], snapshotId],
      );
    }

    await expect(repository.revokeClient({ clientRecordId, reason: "security_response", now: new Date() }))
      .resolves.toEqual({ clientRevoked: true, grantsRevoked: 2 });
    for (const digest of digests) {
      await expect(repository.findCurrentCredential({ tokenDigest: digest, resource, now: new Date() })).resolves.toBeNull();
    }
  });
});
