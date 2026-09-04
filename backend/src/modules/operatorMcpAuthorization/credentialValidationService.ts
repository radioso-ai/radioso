import type { OperatorMcpScope } from "@radioso/operator-mcp-contract";

import type {
  OperatorMcpAuthorizationRepositoryPort,
  OperatorMcpCurrentCredential,
  OperatorMcpPrincipal,
} from "./contracts.js";
import { hashOpaqueCredential } from "./domain.js";

type CredentialRepository = Pick<
  OperatorMcpAuthorizationRepositoryPort,
  "findCurrentCredential" | "findCurrentCredentialById" | "markCredentialUsed"
>;

export class OperatorMcpAccessError extends Error {
  constructor(readonly code: "invalid_token" | "invalid_target") {
    super(code);
  }
}

const KNOWN_NON_OPERATOR_PREFIXES = ["radioso_pat_", "radioso_agent_", "radioso_svc_"] as const;

const isUsable = (
  current: OperatorMcpCurrentCredential,
  configuredEpoch: string,
  now: Date,
): boolean => {
  const { credential, grant } = current;
  return current.userDisabledAt === null
    && current.membershipStatus === "active"
    && current.clientStatus === "active"
    && current.currentClientVersion === grant.clientVersion
    && current.currentClientMetadataDigest === current.grantClientMetadataDigest
    && grant.status === "active"
    && grant.revokedAt === null
    && credential.expiresAt.getTime() > now.getTime()
    && credential.grantId === grant.id
    && credential.issuedGrantVersion === grant.version
    && credential.issuedClientVersion === grant.clientVersion
    && credential.issuedClientMetadataSnapshotId === grant.clientMetadataSnapshotId
    && credential.issuedCredentialEpoch === grant.credentialEpoch
    && credential.issuedCredentialEpoch === configuredEpoch;
};

const currentScopes = (current: OperatorMcpCurrentCredential): OperatorMcpScope[] => {
  const granted = new Set(current.grant.toolScopes);
  return current.credential.issuedToolScopes.filter((scope) => granted.has(scope));
};

export class OperatorMcpCredentialValidationService {
  constructor(
    private readonly repository: CredentialRepository,
    private readonly config: { credentialEpoch: string; resource: string },
  ) {}

  private async project(current: OperatorMcpCurrentCredential | null, resource: string, now: Date): Promise<OperatorMcpPrincipal> {
    if (!current || current.grant.resource !== this.config.resource || !isUsable(current, this.config.credentialEpoch, now)) {
      throw new OperatorMcpAccessError("invalid_token");
    }
    const scopes = currentScopes(current);
    if (scopes.length === 0) throw new OperatorMcpAccessError("invalid_token");
    await this.repository.markCredentialUsed({ credentialId: current.credential.id, grantId: current.grant.id, now });
    return {
      credentialId: current.credential.id,
      grantId: current.grant.id,
      grantVersion: current.grant.version,
      accountId: current.grant.accountId,
      workspaceId: current.grant.workspaceId,
      userId: current.grant.userId,
      membershipId: current.grant.membershipId,
      membershipRole: current.membershipRole,
      clientId: current.grant.clientId,
      clientRecordId: current.grant.clientRecordId,
      clientVersion: current.grant.clientVersion,
      clientMetadataSnapshotId: current.grant.clientMetadataSnapshotId,
      resource,
      currentToolScopes: scopes,
      currentOfflineAccess: current.credential.issuedOfflineAccess && current.grant.offlineAccess,
      credentialEpoch: current.credential.issuedCredentialEpoch,
    };
  }

  async validate(input: { accessToken: string; resource: string; now: Date }): Promise<OperatorMcpPrincipal> {
    if (input.resource !== this.config.resource) throw new OperatorMcpAccessError("invalid_target");
    if (KNOWN_NON_OPERATOR_PREFIXES.some((prefix) => input.accessToken.startsWith(prefix))) {
      throw new OperatorMcpAccessError("invalid_token");
    }

    const current = await this.repository.findCurrentCredential({
      tokenDigest: hashOpaqueCredential(input.accessToken),
      resource: input.resource,
      now: input.now,
    });
    return this.project(current, input.resource, input.now);
  }

  async revalidateCredential(input: { credentialId: string; resource: string; now: Date }): Promise<OperatorMcpPrincipal> {
    if (input.resource !== this.config.resource) throw new OperatorMcpAccessError("invalid_target");
    return this.project(await this.repository.findCurrentCredentialById(input), input.resource, input.now);
  }
}
