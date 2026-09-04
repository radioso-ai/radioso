import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type {
  OperatorMcpAuthorizationFlowRepositoryPort,
  OperatorMcpAuthorizationRepositoryPort,
  OperatorMcpAuthorizationTransactionRecord,
  OperatorMcpGrantRepositoryPort,
  OperatorMcpGrantSummaryRecord,
  OperatorMcpClientRepositoryPort,
  OperatorMcpClientSnapshot,
  PersistedOperatorMcpClient,
} from "../../modules/operatorMcpAuthorization/contracts.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  mapOperatorMcpCurrentCredential,
  type OperatorMcpCredentialJoinRow,
} from "./operatorMcpRowMapper.js";

interface DeploymentCredentialStateRow {
  credential_epoch: string;
  key_fingerprint: string;
}

interface AuthorizationTransactionRow {
  id: string;
  client_record_id: string;
  client_id: string;
  client_version: string;
  client_metadata_snapshot_id: string;
  client_metadata_digest: string;
  client_display_name: string;
  application_type: "web" | "native";
  redirect_uri: string;
  state: string;
  code_challenge: string;
  resource: string;
  requested_tool_scopes: OperatorMcpAuthorizationTransactionRecord["requestedToolScopes"];
  requested_offline_access: boolean;
  account_id: string | null;
  user_id: string | null;
  session_id: string | null;
  workspace_id: string | null;
  membership_id: string | null;
  approved_tool_scopes: OperatorMcpAuthorizationTransactionRecord["approvedToolScopes"];
  approved_offline_access: boolean | null;
  status: OperatorMcpAuthorizationTransactionRecord["status"];
  expires_at: Date;
  created_at: Date;
  decided_at: Date | null;
  consumed_at: Date | null;
}

const mapTransaction = (row: AuthorizationTransactionRow): OperatorMcpAuthorizationTransactionRecord => ({
  id: row.id,
  clientRecordId: row.client_record_id,
  clientId: row.client_id,
  clientVersion: row.client_version,
  clientMetadataSnapshotId: row.client_metadata_snapshot_id,
  clientMetadataDigest: row.client_metadata_digest,
  clientDisplayName: row.client_display_name,
  applicationType: row.application_type,
  redirectUri: row.redirect_uri,
  state: row.state,
  codeChallenge: row.code_challenge,
  resource: row.resource,
  requestedToolScopes: row.requested_tool_scopes,
  requestedOfflineAccess: row.requested_offline_access,
  accountId: row.account_id,
  userId: row.user_id,
  sessionId: row.session_id,
  workspaceId: row.workspace_id,
  membershipId: row.membership_id,
  approvedToolScopes: row.approved_tool_scopes,
  approvedOfflineAccess: row.approved_offline_access,
  status: row.status,
  expiresAt: new Date(row.expires_at),
  createdAt: new Date(row.created_at),
  decidedAt: row.decided_at ? new Date(row.decided_at) : null,
  consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
});

interface GrantSummaryRow {
  id: string; client_id: string; client_name: string; client_version: string; client_metadata_digest: string;
  workspace_id: string; workspace_name: string; user_id: string; user_name: string | null;
  scopes: OperatorMcpGrantSummaryRecord["scopes"]; offline_access: boolean; status: OperatorMcpGrantSummaryRecord["status"];
  resource: string; redirect_uri: string | null; created_at: Date; last_used_at: Date | null;
  revoked_at: Date | null; revoked_reason: string | null; credential_count: string; recent_invocation_count: string;
}

const mapGrantSummary = (row: GrantSummaryRow): OperatorMcpGrantSummaryRecord => ({
  id: row.id, clientId: row.client_id, clientName: row.client_name, clientVersion: row.client_version,
  clientMetadataDigest: row.client_metadata_digest, workspaceId: row.workspace_id, workspaceName: row.workspace_name,
  userId: row.user_id, userName: row.user_name, scopes: row.scopes, offlineAccess: row.offline_access,
  status: row.status, resource: row.resource,
  redirectHost: row.redirect_uri ? new URL(row.redirect_uri).host : "",
  createdAt: new Date(row.created_at), lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null, revokedReason: row.revoked_reason,
  credentialCount: Number(row.credential_count), recentInvocationCount: Number(row.recent_invocation_count),
});

export class OperatorMcpAuthorizationRepository implements OperatorMcpAuthorizationRepositoryPort, OperatorMcpAuthorizationFlowRepositoryPort, OperatorMcpGrantRepositoryPort, OperatorMcpClientRepositoryPort {
  constructor(private readonly db: Db) {}

  private async findCredential(input: ({ tokenDigest: string } | { credentialId: string }) & { resource: string; now: Date }) {
    const selector = "tokenDigest" in input
      ? sql<boolean>`oc.token_digest = ${input.tokenDigest}`
      : sql<boolean>`oc.id = ${input.credentialId}`;
    const result = await sql<OperatorMcpCredentialJoinRow>`
      SELECT
        oc.id AS credential_id,
        oc.token_digest,
        oc.issued_grant_version::text AS issued_grant_version,
        oc.issued_client_version::text AS issued_client_version,
        oc.issued_client_metadata_snapshot_id,
        oc.issued_credential_epoch::text AS issued_credential_epoch,
        oc.issued_tool_scopes,
        oc.issued_offline_access,
        oc.expires_at AS credential_expires_at,
        oc.created_at AS credential_created_at,
        oc.last_used_at AS credential_last_used_at,
        og.id AS grant_id,
        og.client_id AS client_record_id,
        client.client_id,
        og.client_version::text AS client_version,
        og.client_metadata_snapshot_id,
        og.account_id,
        og.workspace_id,
        og.user_id,
        og.membership_id,
        og.resource,
        og.tool_scopes,
        og.offline_access,
        og.status AS grant_status,
        og.version::text AS grant_version,
        og.credential_epoch::text AS credential_epoch,
        og.created_at AS grant_created_at,
        og.updated_at AS grant_updated_at,
        og.last_used_at AS grant_last_used_at,
        og.revoked_at AS grant_revoked_at,
        og.revoked_reason,
        client.status AS client_status,
        client.version::text AS current_client_version,
        client.metadata_digest AS current_client_metadata_digest,
        grant_snapshot.metadata_digest AS grant_client_metadata_digest,
        membership.status AS membership_status,
        membership.role AS membership_role,
        users.disabled_at AS user_disabled_at
      FROM operator_mcp_access_credentials oc
      JOIN operator_mcp_grants og ON og.id = oc.grant_id
      JOIN operator_mcp_clients client ON client.id = og.client_id
      JOIN operator_mcp_client_metadata_snapshots grant_snapshot ON grant_snapshot.id = og.client_metadata_snapshot_id
      JOIN account_memberships membership ON membership.id = og.membership_id
      JOIN users ON users.id = og.user_id
      WHERE ${selector}
        AND oc.expires_at > ${input.now}
        AND og.resource = ${input.resource}
        AND og.status = 'active'
      LIMIT 1
    `.execute(this.db);
    return result.rows[0] ? mapOperatorMcpCurrentCredential(result.rows[0]) : null;
  }

  async findCurrentCredential(input: { tokenDigest: string; resource: string; now: Date }) {
    return this.findCredential(input);
  }

  async findCurrentCredentialById(input: { credentialId: string; resource: string; now: Date }) {
    return this.findCredential(input);
  }

  async markCredentialUsed(input: { credentialId: string; grantId: string; now: Date }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`UPDATE operator_mcp_access_credentials SET last_used_at = ${input.now} WHERE id = ${input.credentialId}`.execute(trx);
      await sql`UPDATE operator_mcp_grants SET last_used_at = ${input.now}, updated_at = ${input.now} WHERE id = ${input.grantId}`.execute(trx);
    });
  }

  async revokeGrant(input: { grantId: string; reason: string; now: Date }): Promise<boolean> {
    const result = await sql`
      UPDATE operator_mcp_grants
      SET status = 'revoked', revoked_at = ${input.now}, revoked_reason = ${input.reason},
          version = version + 1, updated_at = ${input.now}
      WHERE id = ${input.grantId} AND status = 'active'
      RETURNING id
    `.execute(this.db);
    return result.rows.length > 0;
  }

  async revokeClient(input: { clientRecordId: string; reason: string; now: Date }): Promise<{
    clientRevoked: boolean;
    grantsRevoked: number;
  }> {
    return this.db.transaction().execute(async (trx) => {
      const client = await sql`
        UPDATE operator_mcp_clients
        SET status = 'revoked', version = version + 1, updated_at = ${input.now}
        WHERE id = ${input.clientRecordId} AND status = 'active'
        RETURNING id
      `.execute(trx);
      const grants = await sql`
        UPDATE operator_mcp_grants
        SET status = 'revoked', version = version + 1, revoked_at = ${input.now},
          revoked_reason = ${input.reason}, updated_at = ${input.now}
        WHERE client_id = ${input.clientRecordId} AND status = 'active'
        RETURNING id
      `.execute(trx);
      return { clientRevoked: client.rows.length === 1, grantsRevoked: grants.rows.length };
    });
  }

  async ensureDeploymentCredentialState(input: {
    resource: string;
    credentialEpoch: string;
    keyFingerprint: string;
    now: Date;
  }): Promise<"initialized" | "current"> {
    return this.db.transaction().execute(async (trx) => {
      const inserted = await sql<{ resource: string }>`
        INSERT INTO operator_mcp_deployment_credential_state
          (resource, credential_epoch, key_fingerprint, updated_at)
        VALUES (${input.resource}, ${input.credentialEpoch}, ${input.keyFingerprint}, ${input.now})
        ON CONFLICT (resource) DO NOTHING
        RETURNING resource
      `.execute(trx);
      if (inserted.rows.length === 1) return "initialized" as const;

      const selected = await sql<DeploymentCredentialStateRow>`
        SELECT credential_epoch::text AS credential_epoch, key_fingerprint
        FROM operator_mcp_deployment_credential_state
        WHERE resource = ${input.resource}
        FOR UPDATE
      `.execute(trx);
      const current = selected.rows[0];
      if (!current) throw new Error("Operator MCP credential state initialization did not produce a row");
      const configuredEpoch = BigInt(input.credentialEpoch);
      const persistedEpoch = BigInt(current.credential_epoch);
      if (configuredEpoch < persistedEpoch) throw new Error("Configured operator MCP credential epoch is older than persisted state");
      if (configuredEpoch === persistedEpoch) {
        if (current.key_fingerprint !== input.keyFingerprint) throw new Error("Operator MCP key fingerprint differs within the configured epoch");
        return "current" as const;
      }
      throw new Error("Configured operator MCP credential epoch requires explicit rotation before replicas can become ready");
    });
  }

  async advanceDeploymentCredentialState(input: {
    resource: string;
    currentCredentialEpoch: string;
    credentialEpoch: string;
    keyFingerprint: string;
    now: Date;
  }): Promise<boolean> {
    if (BigInt(input.credentialEpoch) <= BigInt(input.currentCredentialEpoch)) {
      throw new Error("Operator MCP credential rotation must increase the external epoch");
    }
    const result = await sql`
      UPDATE operator_mcp_deployment_credential_state
      SET credential_epoch = ${input.credentialEpoch}, key_fingerprint = ${input.keyFingerprint}, updated_at = ${input.now}
      WHERE resource = ${input.resource} AND credential_epoch = ${input.currentCredentialEpoch}
      RETURNING resource
    `.execute(this.db);
    return result.rows.length === 1;
  }

  async createTransaction(input: Parameters<OperatorMcpAuthorizationFlowRepositoryPort["createTransaction"]>[0]): Promise<void> {
    await sql`
      INSERT INTO operator_mcp_authorization_transactions (
        id, client_id, client_metadata_snapshot_id, client_metadata_digest, redirect_uri, state,
        code_challenge, resource, requested_tool_scopes, requested_offline_access, expires_at, created_at
      ) VALUES (
        ${input.id}, ${input.clientRecordId}, ${input.clientMetadataSnapshotId}, ${input.clientMetadataDigest},
        ${input.redirectUri}, ${input.state}, ${input.codeChallenge}, ${input.resource},
        ${input.requestedToolScopes}, ${input.requestedOfflineAccess}, ${input.expiresAt}, ${input.createdAt}
      )
    `.execute(this.db);
  }

  async findTransaction(transactionId: string, now: Date): Promise<OperatorMcpAuthorizationTransactionRecord | null> {
    const result = await sql<AuthorizationTransactionRow>`
      SELECT tx.id, tx.client_id AS client_record_id, client.client_id,
        client.version::text AS client_version, tx.client_metadata_snapshot_id,
        tx.client_metadata_digest, client.display_name AS client_display_name,
        client.application_type, tx.redirect_uri, tx.state, tx.code_challenge, tx.resource,
        tx.requested_tool_scopes, tx.requested_offline_access, tx.account_id, tx.user_id,
        tx.session_id, tx.workspace_id, tx.membership_id, tx.approved_tool_scopes,
        tx.approved_offline_access, tx.status, tx.expires_at, tx.created_at, tx.decided_at, tx.consumed_at
      FROM operator_mcp_authorization_transactions tx
      JOIN operator_mcp_clients client ON client.id = tx.client_id
      WHERE tx.id = ${transactionId}
      LIMIT 1
    `.execute(this.db);
    if (!result.rows[0]) return null;
    const transaction = mapTransaction(result.rows[0]);
    return transaction.status === "pending" && transaction.expiresAt.getTime() <= now.getTime()
      ? { ...transaction, status: "expired" as const }
      : transaction;
  }

  async decideTransaction(input: Parameters<OperatorMcpAuthorizationFlowRepositoryPort["decideTransaction"]>[0]): Promise<boolean> {
    const result = await sql`
      UPDATE operator_mcp_authorization_transactions tx
      SET account_id = ${input.accountId}, user_id = ${input.userId}, session_id = ${input.sessionId},
        workspace_id = ${input.workspaceId}, membership_id = ${input.membershipId},
        approved_tool_scopes = ${input.approvedToolScopes}, approved_offline_access = ${input.approvedOfflineAccess},
        authorization_code_digest = ${input.authorizationCodeDigest}, status = ${input.status}, decided_at = ${input.now}
      WHERE tx.id = ${input.transactionId} AND tx.status = 'pending' AND tx.expires_at > ${input.now}
        AND EXISTS (
          SELECT 1 FROM sessions session
          JOIN users account_user ON account_user.id = session.user_id
          WHERE session.id = ${input.sessionId} AND session.user_id = ${input.userId}
            AND session.account_id = ${input.accountId} AND session.revoked_at IS NULL
            AND session.expires_at > ${input.now} AND account_user.disabled_at IS NULL
        )
        AND (
          ${input.status} = 'denied'
          OR EXISTS (
            SELECT 1 FROM account_memberships membership
            JOIN workspaces workspace ON workspace.id = ${input.workspaceId}
            WHERE membership.id = ${input.membershipId} AND membership.user_id = ${input.userId}
              AND membership.account_id = ${input.accountId} AND membership.status = 'active'
              AND workspace.account_id = ${input.accountId}
          )
        )
      RETURNING tx.id
    `.execute(this.db);
    return result.rows.length === 1;
  }

  async exchangeAuthorizationCode(input: Parameters<OperatorMcpAuthorizationFlowRepositoryPort["exchangeAuthorizationCode"]>[0]) {
    return this.db.transaction().execute(async (trx) => {
      const selected = await sql<AuthorizationTransactionRow>`
        SELECT tx.id, tx.client_id AS client_record_id, client.client_id,
          client.version::text AS client_version, tx.client_metadata_snapshot_id,
          tx.client_metadata_digest, client.display_name AS client_display_name,
          client.application_type, tx.redirect_uri, tx.state, tx.code_challenge, tx.resource,
          tx.requested_tool_scopes, tx.requested_offline_access, tx.account_id, tx.user_id,
          tx.session_id, tx.workspace_id, tx.membership_id, tx.approved_tool_scopes,
          tx.approved_offline_access, tx.status, tx.expires_at, tx.created_at, tx.decided_at, tx.consumed_at
        FROM operator_mcp_authorization_transactions tx
        JOIN operator_mcp_clients client ON client.id = tx.client_id
        JOIN operator_mcp_client_metadata_snapshots snapshot ON snapshot.id = tx.client_metadata_snapshot_id
        JOIN account_memberships membership ON membership.id = tx.membership_id
        JOIN users account_user ON account_user.id = tx.user_id
        WHERE tx.authorization_code_digest = ${input.authorizationCodeDigest}
          AND tx.status = 'approved' AND tx.expires_at > ${input.now}
          AND client.client_id = ${input.clientId} AND client.status = 'active'
          AND client.version = snapshot.client_version AND snapshot.metadata_digest = tx.client_metadata_digest
          AND tx.redirect_uri = ${input.redirectUri} AND tx.resource = ${input.resource}
          AND tx.code_challenge = ${input.codeChallenge}
          AND membership.status = 'active' AND account_user.disabled_at IS NULL
        FOR UPDATE OF tx
      `.execute(trx);
      const transaction = selected.rows[0];
      if (!transaction?.approved_tool_scopes || !transaction.account_id || !transaction.workspace_id
        || !transaction.user_id || !transaction.membership_id) return null;
      const requested = input.requestedToolScopes ?? transaction.approved_tool_scopes;
      const ceiling = new Set(transaction.approved_tool_scopes);
      if (requested.length === 0 || requested.some((scope) => !ceiling.has(scope))) return null;

      await sql`
        UPDATE operator_mcp_grants SET status = 'superseded', version = version + 1,
          updated_at = ${input.now}, revoked_at = ${input.now}, revoked_reason = 'replaced'
        WHERE user_id = ${transaction.user_id} AND client_id = ${transaction.client_record_id}
          AND workspace_id = ${transaction.workspace_id} AND resource = ${input.resource} AND status = 'active'
      `.execute(trx);
      const grantId = randomUUID();
      await sql`
        INSERT INTO operator_mcp_grants (
          id, client_id, client_version, client_metadata_snapshot_id, account_id, workspace_id,
          user_id, membership_id, resource, tool_scopes, offline_access, status, version,
          credential_epoch, created_at, updated_at
        ) VALUES (
          ${grantId}, ${transaction.client_record_id}, ${transaction.client_version}, ${transaction.client_metadata_snapshot_id},
          ${transaction.account_id}, ${transaction.workspace_id}, ${transaction.user_id}, ${transaction.membership_id},
          ${input.resource}, ${requested}, ${transaction.approved_offline_access === true}, 'active', 1,
          ${input.credentialEpoch}, ${input.now}, ${input.now}
        )
      `.execute(trx);
      await sql`
        INSERT INTO operator_mcp_access_credentials (
          id, grant_id, token_digest, issued_grant_version, issued_client_version,
          issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
          issued_offline_access, expires_at, created_at
        ) VALUES (
          ${input.accessCredential.id}, ${grantId}, ${input.accessCredential.tokenDigest}, 1, ${transaction.client_version},
          ${transaction.client_metadata_snapshot_id}, ${input.credentialEpoch}, ${requested},
          ${transaction.approved_offline_access === true}, ${input.accessCredential.expiresAt}, ${input.now}
        )
      `.execute(trx);
      if (transaction.approved_offline_access && input.refreshCredential) {
        await sql`
          INSERT INTO operator_mcp_refresh_lineages (
            id, grant_id, client_version, client_metadata_snapshot_id, credential_epoch, status,
            current_generation, issued_tool_scopes, offline_access, idle_expires_at, absolute_expires_at, created_at
          ) VALUES (
            ${input.refreshCredential.lineageId}, ${grantId}, ${transaction.client_version},
            ${transaction.client_metadata_snapshot_id}, ${input.credentialEpoch}, 'active', 1,
            ${requested}, true, ${input.refreshCredential.idleExpiresAt}, ${input.refreshCredential.absoluteExpiresAt}, ${input.now}
          )
        `.execute(trx);
        await sql`
          INSERT INTO operator_mcp_refresh_generations
            (lineage_id, generation, token_digest, issued_tool_scopes, created_at)
          VALUES (${input.refreshCredential.lineageId}, 1, ${input.refreshCredential.tokenDigest}, ${requested}, ${input.now})
        `.execute(trx);
      }
      await sql`
        UPDATE operator_mcp_authorization_transactions
        SET status = 'consumed', consumed_at = ${input.now}
        WHERE id = ${transaction.id} AND status = 'approved'
      `.execute(trx);
      return {
        grantId,
        toolScopes: requested,
        offlineAccess: transaction.approved_offline_access === true,
        attribution: {
          accountId: transaction.account_id,
          workspaceId: transaction.workspace_id,
          userId: transaction.user_id,
          clientRecordId: transaction.client_record_id,
          grantId,
        },
      };
    });
  }

  async rotateRefreshCredential(input: Parameters<OperatorMcpAuthorizationFlowRepositoryPort["rotateRefreshCredential"]>[0]) {
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<{
        lineage_id: string; generation: string; consumed_at: Date | null; current_generation: string;
        issued_tool_scopes: OperatorMcpAuthorizationTransactionRecord["requestedToolScopes"];
        grant_id: string; grant_scopes: OperatorMcpAuthorizationTransactionRecord["requestedToolScopes"];
        account_id: string; workspace_id: string; user_id: string; client_record_id: string;
      }>`
        SELECT generation.lineage_id, generation.generation::text, generation.consumed_at,
          lineage.current_generation::text, lineage.issued_tool_scopes, lineage.grant_id,
          oauth_grant.tool_scopes AS grant_scopes, oauth_grant.account_id, oauth_grant.workspace_id,
          oauth_grant.user_id, oauth_grant.client_id AS client_record_id
        FROM operator_mcp_refresh_generations generation
        JOIN operator_mcp_refresh_lineages lineage ON lineage.id = generation.lineage_id
        JOIN operator_mcp_grants oauth_grant ON oauth_grant.id = lineage.grant_id
        JOIN operator_mcp_clients client ON client.id = oauth_grant.client_id
        JOIN account_memberships membership ON membership.id = oauth_grant.membership_id
        JOIN users account_user ON account_user.id = oauth_grant.user_id
        WHERE generation.token_digest = ${input.tokenDigest}
          AND oauth_grant.resource = ${input.resource} AND client.client_id = ${input.clientId}
          AND lineage.credential_epoch = ${input.credentialEpoch}
          AND lineage.status = 'active' AND lineage.idle_expires_at > ${input.now}
          AND lineage.absolute_expires_at > ${input.now} AND oauth_grant.status = 'active'
          AND client.status = 'active' AND client.version = lineage.client_version
          AND membership.status = 'active' AND account_user.disabled_at IS NULL
        FOR UPDATE OF lineage, generation, oauth_grant
      `.execute(trx);
      const row = result.rows[0];
      if (!row) return { status: "invalid" as const };
      const attribution = {
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        clientRecordId: row.client_record_id,
        grantId: row.grant_id,
      };
      if (row.consumed_at || row.generation !== row.current_generation) {
        await sql`
          UPDATE operator_mcp_refresh_lineages SET status = 'revoked', revoked_at = ${input.now}, revoked_reason = 'replay'
          WHERE id = ${row.lineage_id}
        `.execute(trx);
        await sql`
          UPDATE operator_mcp_grants SET status = 'revoked', version = version + 1,
            revoked_at = ${input.now}, revoked_reason = 'refresh_replay', updated_at = ${input.now}
          WHERE id = ${row.grant_id} AND status = 'active'
        `.execute(trx);
        return { status: "replay" as const, attribution };
      }
      const ceiling = new Set(row.issued_tool_scopes.filter((scope) => row.grant_scopes.includes(scope)));
      const scopes = input.requestedToolScopes ?? [...ceiling];
      if (scopes.length === 0 || scopes.some((scope) => !ceiling.has(scope))) return { status: "invalid" as const };
      const nextGeneration = (BigInt(row.generation) + 1n).toString();
      await sql`
        UPDATE operator_mcp_refresh_generations SET consumed_at = ${input.now}
        WHERE lineage_id = ${row.lineage_id} AND generation = ${row.generation}
      `.execute(trx);
      await sql`
        INSERT INTO operator_mcp_refresh_generations
          (lineage_id, generation, token_digest, issued_tool_scopes, created_at)
        VALUES (${row.lineage_id}, ${nextGeneration}, ${input.successorTokenDigest}, ${scopes}, ${input.now})
      `.execute(trx);
      await sql`
        UPDATE operator_mcp_refresh_lineages
        SET current_generation = ${nextGeneration}, issued_tool_scopes = ${scopes}, idle_expires_at = LEAST(${input.idleExpiresAt}, absolute_expires_at)
        WHERE id = ${row.lineage_id}
      `.execute(trx);
      await sql`
        INSERT INTO operator_mcp_access_credentials (
          id, grant_id, token_digest, issued_grant_version, issued_client_version,
          issued_client_metadata_snapshot_id, issued_credential_epoch, issued_tool_scopes,
          issued_offline_access, expires_at, created_at
        )
        SELECT ${input.accessCredential.id}, oauth_grant.id, ${input.accessCredential.tokenDigest}, oauth_grant.version,
          oauth_grant.client_version, oauth_grant.client_metadata_snapshot_id, oauth_grant.credential_epoch,
          ${scopes}, true, ${input.accessCredential.expiresAt}, ${input.now}
        FROM operator_mcp_grants oauth_grant WHERE oauth_grant.id = ${row.grant_id} AND oauth_grant.status = 'active'
      `.execute(trx);
      return { status: "rotated" as const, grantId: row.grant_id, toolScopes: scopes, attribution };
    });
  }

  async revokeCredentialByDigest(input: Parameters<OperatorMcpAuthorizationFlowRepositoryPort["revokeCredentialByDigest"]>[0]) {
    return this.db.transaction().execute(async (trx) => {
      const access = await sql<{ grant_id: string }>`
        SELECT grant_id FROM operator_mcp_access_credentials WHERE token_digest = ${input.tokenDigest}
      `.execute(trx);
      const refresh = access.rows[0] ? null : await sql<{ grant_id: string }>`
        SELECT lineage.grant_id FROM operator_mcp_refresh_generations generation
        JOIN operator_mcp_refresh_lineages lineage ON lineage.id = generation.lineage_id
        WHERE generation.token_digest = ${input.tokenDigest}
      `.execute(trx);
      const grantId = access.rows[0]?.grant_id ?? refresh?.rows[0]?.grant_id;
      if (!grantId) return null;
      const identity = await sql<{
        account_id: string; workspace_id: string; user_id: string; client_record_id: string;
      }>`
        SELECT account_id, workspace_id, user_id, client_id AS client_record_id
        FROM operator_mcp_grants WHERE id = ${grantId}
      `.execute(trx);
      const row = identity.rows[0];
      if (!row) return null;
      await sql`
        UPDATE operator_mcp_grants SET status = 'revoked', version = version + 1,
          revoked_at = ${input.now}, revoked_reason = 'oauth_revocation', updated_at = ${input.now}
        WHERE id = ${grantId} AND status = 'active'
      `.execute(trx);
      await sql`
        UPDATE operator_mcp_refresh_lineages SET status = 'revoked', revoked_at = ${input.now}, revoked_reason = 'oauth_revocation'
        WHERE grant_id = ${grantId} AND status = 'active'
      `.execute(trx);
      return {
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        userId: row.user_id,
        clientRecordId: row.client_record_id,
        grantId,
      };
    });
  }

  async listGrants(input: { workspaceId: string; userId?: string }): Promise<readonly OperatorMcpGrantSummaryRecord[]> {
    const result = await sql<GrantSummaryRow>`
      SELECT oauth_grant.id, client.client_id, client.display_name AS client_name,
        oauth_grant.client_version::text AS client_version, snapshot.metadata_digest AS client_metadata_digest,
        oauth_grant.workspace_id, workspace.name AS workspace_name, oauth_grant.user_id,
        account_user.email AS user_name, oauth_grant.tool_scopes AS scopes, oauth_grant.offline_access,
        oauth_grant.status, oauth_grant.resource, client.redirect_uris->>0 AS redirect_uri,
        oauth_grant.created_at, oauth_grant.last_used_at, oauth_grant.revoked_at, oauth_grant.revoked_reason,
        (SELECT COUNT(*) FROM operator_mcp_access_credentials credential WHERE credential.grant_id = oauth_grant.id)::text AS credential_count,
        (SELECT COUNT(*) FROM operator_mcp_invocations invocation
          WHERE invocation.grant_id = oauth_grant.id AND invocation.created_at > NOW() - INTERVAL '24 hours')::text AS recent_invocation_count
      FROM operator_mcp_grants oauth_grant
      JOIN operator_mcp_clients client ON client.id = oauth_grant.client_id
      JOIN operator_mcp_client_metadata_snapshots snapshot ON snapshot.id = oauth_grant.client_metadata_snapshot_id
      JOIN workspaces workspace ON workspace.id = oauth_grant.workspace_id
      JOIN users account_user ON account_user.id = oauth_grant.user_id
      WHERE oauth_grant.workspace_id = ${input.workspaceId}
        AND (${input.userId ?? null}::uuid IS NULL OR oauth_grant.user_id = ${input.userId ?? null})
      ORDER BY oauth_grant.created_at DESC, oauth_grant.id DESC
    `.execute(this.db);
    return result.rows.map(mapGrantSummary);
  }

  async findGrant(input: { workspaceId: string; grantId: string }): Promise<OperatorMcpGrantSummaryRecord | null> {
    const rows = await this.listGrants({ workspaceId: input.workspaceId });
    return rows.find((grant) => grant.id === input.grantId) ?? null;
  }

  async persistClientSnapshot(snapshot: OperatorMcpClientSnapshot): Promise<PersistedOperatorMcpClient> {
    return this.db.transaction().execute(async (trx) => {
      const existing = await sql<{ id: string; version: string; metadata_digest: string; status: string }>`
        SELECT id, version::text, metadata_digest, status
        FROM operator_mcp_clients WHERE client_id = ${snapshot.clientId} FOR UPDATE
      `.execute(trx);
      const current = existing.rows[0];
      if (current && current.status !== "active") throw new Error("Operator MCP client is not active");
      const clientRecordId = current?.id ?? randomUUID();
      const clientVersion = current
        ? (current.metadata_digest === snapshot.metadataDigest ? current.version : (BigInt(current.version) + 1n).toString())
        : "1";
      if (!current) {
        await sql`
          INSERT INTO operator_mcp_clients (
            id, client_id, registration_method, application_type, display_name, redirect_uris,
            token_endpoint_auth_method, metadata_digest, version, status, expires_at, created_at, updated_at
          ) VALUES (
            ${clientRecordId}, ${snapshot.clientId}, ${snapshot.source === "metadata_document" ? "metadata_document" : "preregistered"}, ${snapshot.applicationType}, ${snapshot.displayName},
            ${JSON.stringify(snapshot.redirectUris)}::jsonb, 'none', ${snapshot.metadataDigest}, ${clientVersion}, 'active',
            ${snapshot.expiresAt}, ${snapshot.validatedAt}, ${snapshot.validatedAt}
          )
        `.execute(trx);
      } else if (current.metadata_digest !== snapshot.metadataDigest) {
        await sql`
          UPDATE operator_mcp_clients SET application_type = ${snapshot.applicationType}, display_name = ${snapshot.displayName},
            redirect_uris = ${JSON.stringify(snapshot.redirectUris)}::jsonb, metadata_digest = ${snapshot.metadataDigest},
            version = ${clientVersion}, expires_at = ${snapshot.expiresAt}, updated_at = ${snapshot.validatedAt}
          WHERE id = ${clientRecordId}
        `.execute(trx);
      }
      const matching = await sql<{ id: string }>`
        SELECT id FROM operator_mcp_client_metadata_snapshots
        WHERE client_id = ${clientRecordId} AND client_version = ${clientVersion} AND metadata_digest = ${snapshot.metadataDigest}
        LIMIT 1
      `.execute(trx);
      const metadataSnapshotId = matching.rows[0]?.id ?? snapshot.id;
      if (!matching.rows[0]) {
        await sql`
          INSERT INTO operator_mcp_client_metadata_snapshots (
            id, client_id, client_version, metadata_digest, normalized_metadata, source, validated_at, expires_at
          ) VALUES (
            ${metadataSnapshotId}, ${clientRecordId}, ${clientVersion}, ${snapshot.metadataDigest},
            ${JSON.stringify(snapshot.normalizedMetadata)}::jsonb, ${snapshot.source}, ${snapshot.validatedAt}, ${snapshot.expiresAt}
          )
        `.execute(trx);
      }
      return {
        recordId: clientRecordId,
        clientId: snapshot.clientId,
        clientVersion,
        metadataSnapshotId,
        metadataDigest: snapshot.metadataDigest,
        applicationType: snapshot.applicationType,
        redirectUris: snapshot.redirectUris,
        displayName: snapshot.displayName,
      };
    });
  }
}
