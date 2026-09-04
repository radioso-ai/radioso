import { forbidden, notFound } from "../../shared/domain/errors.js";

import type { OperatorMcpGrantRepositoryPort, OperatorMcpGrantSummaryRecord } from "./contracts.js";

type WorkspaceRoleReader = {
  resolveWorkspaceRole(input: { accountId: string; userId: string; workspaceId: string }): Promise<string | null>;
};

const canAdmin = (role: string | null): boolean => role === "owner" || role === "admin";

const present = (record: OperatorMcpGrantSummaryRecord, actorUserId: string, administrator: boolean) => ({
  id: record.id,
  clientId: record.clientId,
  clientName: record.clientName,
  clientVersion: record.clientVersion,
  clientMetadataDigest: record.clientMetadataDigest,
  workspaceId: record.workspaceId,
  workspaceName: record.workspaceName,
  userId: record.userId,
  userName: record.userName,
  scopes: record.scopes,
  offlineAccess: record.offlineAccess,
  status: record.status,
  createdAt: record.createdAt.toISOString(),
  lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  revokedAt: record.revokedAt?.toISOString() ?? null,
  revokedReason: record.revokedReason,
  canRevoke: record.userId === actorUserId || administrator,
  isOwner: record.userId === actorUserId,
});

export class OperatorMcpGrantService {
  constructor(
    private readonly repository: OperatorMcpGrantRepositoryPort,
    private readonly roles: WorkspaceRoleReader,
  ) {}

  private async role(input: { accountId: string; workspaceId: string; actorUserId: string }): Promise<string> {
    const role = await this.roles.resolveWorkspaceRole({
      accountId: input.accountId, workspaceId: input.workspaceId, userId: input.actorUserId,
    });
    if (!role) throw forbidden();
    return role;
  }

  async list(input: { accountId: string; workspaceId: string; actorUserId: string }) {
    const role = await this.role(input);
    const administrator = canAdmin(role);
    const grants = await this.repository.listGrants({
      workspaceId: input.workspaceId,
      ...(administrator ? {} : { userId: input.actorUserId }),
    });
    return { grants: grants.map((grant) => present(grant, input.actorUserId, administrator)), canViewWorkspace: administrator };
  }

  async get(input: { accountId: string; workspaceId: string; actorUserId: string; grantId: string }) {
    const role = await this.role(input);
    const administrator = canAdmin(role);
    const grant = await this.repository.findGrant({ workspaceId: input.workspaceId, grantId: input.grantId });
    if (!grant) throw notFound("Operator MCP grant not found");
    if (grant.userId !== input.actorUserId && !administrator) throw forbidden();
    return {
      ...present(grant, input.actorUserId, administrator),
      redirectHost: grant.redirectHost,
      resource: grant.resource,
      credentialCount: grant.credentialCount,
      recentInvocationCount: grant.recentInvocationCount,
    };
  }

  async revoke(input: { accountId: string; workspaceId: string; actorUserId: string; grantId: string; now: Date }) {
    const current = await this.get(input);
    if (!current.canRevoke) throw forbidden();
    if (current.status === "active") {
      await this.repository.revokeGrant({ grantId: input.grantId, reason: "dashboard_revocation", now: input.now });
    }
    return (await this.repository.findGrant({ workspaceId: input.workspaceId, grantId: input.grantId }))
      ? this.get(input)
      : current;
  }
}
