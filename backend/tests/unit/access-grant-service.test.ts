import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { DefaultOriginMatcher } from "../../src/modules/accessGrants/originMatcher.js";
import { AccessGrantService } from "../../src/modules/accessGrants/services/accessGrantService.js";
import { InMemoryAccessGrantRepository } from "../support/fakes.js";

const createService = () => {
  const repository = new InMemoryAccessGrantRepository();
  const service = new AccessGrantService({
    repository,
    originMatcher: new DefaultOriginMatcher(),
    workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
  });
  return { repository, service };
};

const futureExpiry = () => new Date(Date.now() + 60_000);

describe("AccessGrantService", () => {
  it("stores role-free agent channel credentials as hash-only grants", async () => {
    const { repository, service } = createService();

    const issued = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: futureExpiry(),
    });

    expect(issued.grant).toMatchObject({
      principalKind: "agent-api",
      channel: "mcp-converse",
      role: "agent",
      encryptedToken: null,
    });
    expect(repository.items[0]?.tokenHash).not.toBe(issued.token);
    expect(JSON.stringify(repository.items[0])).not.toContain(issued.token);
    expect(issued.grant.tokenPrefix).toBe(issued.token.slice(0, "radioso_".length + 8));
  });

  it("normalizes access-grant labels and rejects control characters", async () => {
    const { service } = createService();
    const input = {
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api" as const,
      channel: "agent-api" as const,
      originConstraint: { mode: "allow-all" as const, origins: [] as [] },
      expiresAt: futureExpiry(),
    };

    await expect(service.issueGrant({ ...input, label: "  cafe\u0301  " })).resolves.toMatchObject({
      grant: { label: "café" },
    });
    await expect(service.issueGrant({ ...input, label: "bad\nlabel" })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("never rotates a revoked or expired agent-channel credential", async () => {
    const { repository, service } = createService();
    const issued = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: futureExpiry(),
    });
    const originalHash = issued.grant.tokenHash;
    await service.revokeGrant({ grantId: issued.grant.id });

    await expect(service.rotateGrant({ grantId: issued.grant.id })).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.items[0]?.tokenHash).toBe(originalHash);
    expect(repository.items[0]?.revokedAt).not.toBeNull();

    const expired = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: futureExpiry(),
    });
    const expiredHash = expired.grant.tokenHash;
    expired.grant.expiresAt = new Date(Date.now() - 1);

    await expect(service.rotateGrant({ grantId: expired.grant.id })).rejects.toMatchObject({ statusCode: 400 });
    expect(expired.grant.tokenHash).toBe(expiredHash);
  });

  it("keeps the original revocation timestamp when a grant is revoked repeatedly", async () => {
    const { service } = createService();
    const issued = await service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: futureExpiry(),
    });

    const first = await service.revokeGrant({ grantId: issued.grant.id });
    const second = await service.revokeGrant({ grantId: issued.grant.id });
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });

  it("requires expiry for newly issued agent channel credentials", async () => {
    const { service } = createService();

    await expect(service.issueGrant({
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api",
      channel: "agent-api",
      originConstraint: { mode: "allow-all", origins: [] },
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("resolves only the expected agent channel audience", async () => {
    const { service } = createService();
    const common = {
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      principalKind: "agent-api" as const,
      originConstraint: { mode: "allow-all" as const, origins: [] as [] },
      expiresAt: futureExpiry(),
    };

    const mcp = await service.issueGrant({ ...common, channel: "mcp-converse" });
    const rest = await service.issueGrant({ ...common, channel: "agent-api" });

    await expect(service.resolveAgentChannelGrant(mcp.token, "mcp-converse")).resolves.toMatchObject({ id: mcp.grant.id });
    await expect(service.resolveAgentChannelGrant(mcp.token, "agent-api")).resolves.toBeNull();
    await expect(service.resolveAgentChannelGrant(rest.token, "agent-api")).resolves.toMatchObject({ id: rest.grant.id });
    await expect(service.resolveAgentChannelGrant(rest.token, "mcp-converse")).resolves.toBeNull();
  });

  it("does not resolve workspace or public-launch grants as agent channel credentials", async () => {
    const { service } = createService();
    const common = {
      agentId: randomUUID(),
      workspaceId: randomUUID(),
      role: "agent" as const,
      channel: "mcp-converse" as const,
      originConstraint: { mode: "allow-all" as const, origins: [] as [] },
      expiresAt: futureExpiry(),
    };
    const workspaceGrant = await service.issueGrant({ ...common, principalKind: "workspace-admin" });
    const publicGrant = await service.issueGrant({ ...common, principalKind: "public-launch" });

    await expect(service.resolveAgentChannelGrant(workspaceGrant.token, "mcp-converse")).resolves.toBeNull();
    await expect(service.resolveAgentChannelGrant(publicGrant.token, "mcp-converse")).resolves.toBeNull();
  });

  it("keeps a valid grant usable when last-use persistence fails and reports only the safe failure signal", async () => {
    const repository = new InMemoryAccessGrantRepository();
    repository.touch = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const observer = { recordLastUsePersistenceFailure: vi.fn() };
    const service = new AccessGrantService({
      repository,
      originMatcher: new DefaultOriginMatcher(),
      workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
      usageObserver: observer,
    });

    await expect(service.touchGrant(randomUUID())).resolves.toBeUndefined();
    await Promise.resolve();

    expect(observer.recordLastUsePersistenceFailure).toHaveBeenCalledOnce();
  });

  it("also fails open when a last-use adapter throws before returning a promise", async () => {
    const repository = new InMemoryAccessGrantRepository();
    repository.touch = vi.fn().mockImplementation(() => { throw new Error("database unavailable"); });
    const observer = { recordLastUsePersistenceFailure: vi.fn() };
    const service = new AccessGrantService({
      repository,
      originMatcher: new DefaultOriginMatcher(),
      workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
      usageObserver: observer,
    });

    await expect(service.touchGrant(randomUUID())).resolves.toBeUndefined();

    expect(observer.recordLastUsePersistenceFailure).toHaveBeenCalledOnce();
  });

  it("attributes channel credential lifecycle records to the actor and stable audience", async () => {
    const repository = new InMemoryAccessGrantRepository();
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new AccessGrantService({
      repository,
      originMatcher: new DefaultOriginMatcher(),
      workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
      auditService,
    });

    await service.issueGrant({
      agentId: "agent-1",
      workspaceId: "workspace-1",
      accountId: "account-1",
      actor: { kind: "user", id: "user-1" },
      principalKind: "agent-api",
      channel: "mcp-converse",
      originConstraint: { mode: "allow-all", origins: [] },
      expiresAt: futureExpiry(),
    });

    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "access_grant.issue",
      metadata: expect.objectContaining({
        actor: { kind: "user", id: "user-1" },
        audience: "mcp",
      }),
    }));
  });

  it("records a narrow successful REST chat audit without the secret or chat content", async () => {
    const repository = new InMemoryAccessGrantRepository();
    const auditService = { record: vi.fn().mockResolvedValue(undefined) };
    const service = new AccessGrantService({
      repository,
      originMatcher: new DefaultOriginMatcher(),
      workspaceTokenSecret: "0123456789abcdef0123456789abcdef",
      auditService,
    });

    await service.recordAgentChannelChatSucceeded({
      grant: {
        id: "grant-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        principalKind: "agent-api",
        channel: "agent-api",
        role: "agent",
      },
    });

    expect(auditService.record).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      eventType: "agent_api.chat",
      eventStatus: "success",
      metadata: {
        grantId: "grant-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
        audience: "rest",
        principalKind: "agent-api",
        role: "agent",
      },
    });
  });
});
