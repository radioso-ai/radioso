import type { OperatorMcpScope } from "@radioso/operator-mcp-contract";

import type {
  OperatorMcpCredentialRecord,
  OperatorMcpCurrentCredential,
  OperatorMcpGrantRecord,
} from "../../modules/operatorMcpAuthorization/contracts.js";

export interface OperatorMcpCredentialJoinRow {
  credential_id: string;
  token_digest: string;
  issued_grant_version: string;
  issued_client_version: string;
  issued_client_metadata_snapshot_id: string;
  issued_credential_epoch: string;
  issued_tool_scopes: string[];
  issued_offline_access: boolean;
  credential_expires_at: Date;
  credential_created_at: Date;
  credential_last_used_at: Date | null;
  grant_id: string;
  client_record_id: string;
  client_id: string;
  client_version: string;
  client_metadata_snapshot_id: string;
  account_id: string;
  workspace_id: string;
  user_id: string;
  membership_id: string;
  resource: string;
  tool_scopes: string[];
  offline_access: boolean;
  grant_status: "active" | "revoked" | "superseded" | "expired";
  grant_version: string;
  credential_epoch: string;
  grant_created_at: Date;
  grant_updated_at: Date;
  grant_last_used_at: Date | null;
  grant_revoked_at: Date | null;
  revoked_reason: string | null;
  client_status: "active" | "revoked" | "expired";
  current_client_version: string;
  current_client_metadata_digest: string;
  grant_client_metadata_digest: string;
  membership_status: string;
  membership_role: string;
  user_disabled_at: Date | null;
}

const scopes = (values: string[]): OperatorMcpScope[] => values as OperatorMcpScope[];

export const mapOperatorMcpCurrentCredential = (
  row: OperatorMcpCredentialJoinRow,
): OperatorMcpCurrentCredential => {
  const credential: OperatorMcpCredentialRecord = {
    id: row.credential_id,
    grantId: row.grant_id,
    tokenDigest: row.token_digest,
    issuedGrantVersion: row.issued_grant_version,
    issuedClientVersion: row.issued_client_version,
    issuedClientMetadataSnapshotId: row.issued_client_metadata_snapshot_id,
    issuedCredentialEpoch: row.issued_credential_epoch,
    issuedToolScopes: scopes(row.issued_tool_scopes),
    issuedOfflineAccess: row.issued_offline_access,
    expiresAt: row.credential_expires_at,
    createdAt: row.credential_created_at,
    lastUsedAt: row.credential_last_used_at,
  };
  const grant: OperatorMcpGrantRecord = {
    id: row.grant_id,
    clientRecordId: row.client_record_id,
    clientId: row.client_id,
    clientVersion: row.client_version,
    clientMetadataSnapshotId: row.client_metadata_snapshot_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    membershipId: row.membership_id,
    resource: row.resource,
    toolScopes: scopes(row.tool_scopes),
    offlineAccess: row.offline_access,
    status: row.grant_status,
    version: row.grant_version,
    credentialEpoch: row.credential_epoch,
    createdAt: row.grant_created_at,
    updatedAt: row.grant_updated_at,
    lastUsedAt: row.grant_last_used_at,
    revokedAt: row.grant_revoked_at,
    revokedReason: row.revoked_reason,
  };
  return {
    clientStatus: row.client_status,
    currentClientVersion: row.current_client_version,
    currentClientMetadataDigest: row.current_client_metadata_digest,
    grantClientMetadataDigest: row.grant_client_metadata_digest,
    credential,
    grant,
    membershipRole: row.membership_role,
    membershipStatus: row.membership_status,
    userDisabledAt: row.user_disabled_at,
  };
};
