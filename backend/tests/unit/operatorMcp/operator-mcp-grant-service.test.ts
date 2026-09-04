import { describe, expect, it, vi } from "vitest";

import { OperatorMcpGrantService } from "../../../src/modules/operatorMcpAuthorization/grantService.js";

const record = {
  id: "00000000-0000-4000-8000-000000000001", clientId: "https://client.example/cimd", clientName: "Client", clientVersion: "1",
  clientMetadataDigest: "sha256:digest", workspaceId: "00000000-0000-4000-8000-000000000002", workspaceName: "Workspace",
  userId: "00000000-0000-4000-8000-000000000003", userName: "operator@example.com", scopes: ["operator:read"] as const,
  offlineAccess: false, status: "active" as const, resource: "https://mcp.example/operator/mcp", redirectHost: "client.example",
  createdAt: new Date("2026-09-04T00:00:00Z"), lastUsedAt: null, revokedAt: null, revokedReason: null,
  credentialCount: 1, recentInvocationCount: 0,
};

describe("OperatorMcpGrantService", () => {
  it("lists only own grants for members and workspace grants for owners/admins", async () => {
    const repository = { listGrants: vi.fn(async () => [record]), findGrant: vi.fn(), revokeGrant: vi.fn() };
    const member = new OperatorMcpGrantService(repository, { resolveWorkspaceRole: vi.fn(async () => "member") });
    await expect(member.list({ accountId: "account", workspaceId: record.workspaceId, actorUserId: record.userId })).resolves.toMatchObject({ canViewWorkspace: false });
    expect(repository.listGrants).toHaveBeenLastCalledWith({ workspaceId: record.workspaceId, userId: record.userId });
    const admin = new OperatorMcpGrantService(repository, { resolveWorkspaceRole: vi.fn(async () => "admin") });
    await expect(admin.list({ accountId: "account", workspaceId: record.workspaceId, actorUserId: "admin" })).resolves.toMatchObject({ canViewWorkspace: true });
    expect(repository.listGrants).toHaveBeenLastCalledWith({ workspaceId: record.workspaceId });
  });

  it("allows self or owner/admin revocation and makes it idempotent", async () => {
    const repository = { listGrants: vi.fn(), findGrant: vi.fn(async () => record), revokeGrant: vi.fn(async () => true) };
    const service = new OperatorMcpGrantService(repository, { resolveWorkspaceRole: vi.fn(async () => "member") });
    await expect(service.revoke({ accountId: "account", workspaceId: record.workspaceId, actorUserId: record.userId, grantId: record.id, now: new Date() })).resolves.toMatchObject({ id: record.id, canRevoke: true });
    repository.revokeGrant.mockResolvedValueOnce(false);
    await expect(service.revoke({ accountId: "account", workspaceId: record.workspaceId, actorUserId: record.userId, grantId: record.id, now: new Date() })).resolves.toMatchObject({ id: record.id });
  });

  it("denies a member attempting to inspect another user's grant", async () => {
    const repository = { listGrants: vi.fn(), findGrant: vi.fn(async () => record), revokeGrant: vi.fn() };
    const service = new OperatorMcpGrantService(repository, { resolveWorkspaceRole: vi.fn(async () => "member") });
    await expect(service.get({ accountId: "account", workspaceId: record.workspaceId, actorUserId: "another", grantId: record.id })).rejects.toMatchObject({ statusCode: 403 });
  });
});
