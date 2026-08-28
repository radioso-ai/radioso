import { describe, expect, it } from "vitest";

import {
  AccountAccessService,
  AGENT_CONVERSE_PERMISSIONS,
  PUBLIC_CHAT_PERMISSIONS,
  type AccountPermission,
  type PublicChatPermission,
} from "../../src/modules/account/services/accountAccessService.js";
import {
  createAuditService,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
} from "../support/fakes.js";

describe("AccountAccessService", () => {
  const publicPermissions: PublicChatPermission[] = [
    "public_chat.turn.create",
    "public_chat.session.read.own",
    "public_chat.history.read.own",
    "public_chat.feedback.write.own",
  ];
  const agentConversePermissions: PublicChatPermission[] = [
    ...publicPermissions,
    "public_chat.retrieval.query",
    "public_chat.documents.read.scoped",
  ];

  it("defines the public chat permission set exactly", () => {
    expect([...PUBLIC_CHAT_PERMISSIONS].sort()).toEqual([...publicPermissions].sort());
  });

  it("defines the agent converse permission set as public chat plus scoped retrieval reads", () => {
    expect([...AGENT_CONVERSE_PERMISSIONS].sort()).toEqual([...agentConversePermissions].sort());
  });

  it("allows public chat session principals exactly the public chat permissions", async () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());
    const principal = {
      type: "public_chat_session" as const,
      role: "public" as const,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      publicSessionId: "33333333-3333-3333-3333-333333333333",
    };

    for (const permission of publicPermissions) {
      await expect(service.hasPermission({
        principal,
        permission,
      })).resolves.toBe(true);
    }

    for (const permission of [
      "workspace.chat.use",
      "workspace.settings.read",
      "workspace.documents.read",
      "workspace.token.read",
      "account.users.manage",
    ] as AccountPermission[]) {
      await expect(service.hasPermission({
        principal,
        permission,
      })).resolves.toBe(false);
    }
  });

  it("allows agent converse principals only public chat and scoped retrieval permissions", async () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());
    const principal = {
      type: "public_chat_session" as const,
      role: "agent" as const,
      workspaceId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      publicSessionId: "33333333-3333-3333-3333-333333333333",
    };

    for (const permission of agentConversePermissions) {
      await expect(service.hasPermission({
        principal,
        permission,
      })).resolves.toBe(true);
    }

    for (const permission of [
      "workspace.chat.use",
      "workspace.settings.read",
      "workspace.documents.read",
      "workspace.documents.manage",
      "workspace.token.read",
      "account.users.manage",
    ] as AccountPermission[]) {
      await expect(service.hasPermission({
        principal,
        permission,
      })).resolves.toBe(false);
    }
  });

  it("evaluates an all-of workspace permission vector from one effective principal", async () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());
    const principal = { type: "workspace_api_token" as const, role: "member" as const };

    await expect(service.hasAllWorkspacePermissions({
      principal,
      permissions: ["workspace.agents.read", "workspace.chat.use"],
    })).resolves.toBe(true);
    await expect(service.hasAllWorkspacePermissions({
      principal,
      permissions: ["workspace.agents.read", "workspace.quality.read"],
    })).resolves.toBe(false);
  });

  it("derives role permission vectors from the same authority used for authorization", () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());

    expect(service.permissionsForWorkspaceRole("member", ["workspace.agents.read", "workspace.agents.manage", "workspace.quality.read"])).toEqual(
      new Set(["workspace.agents.read", "workspace.agents.manage"]),
    );
  });

  it("never grants public chat permissions to session users or workspace API tokens", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const user = await userRepository.create({ email: "member@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: user.id, role: "owner" });

    for (const permission of publicPermissions) {
      await expect(service.hasPermission({
        accountId: "account-1",
        principal: { type: "session_user", userId: user.id },
        permission,
      })).resolves.toBe(false);

      await expect(service.hasPermission({
        accountId: "account-1",
        principal: { type: "workspace_api_token", role: "admin", workspaceId: "workspace-1" },
        permission,
      })).resolves.toBe(false);
    }
  });

  it("binds workspace API tokens to their authenticated workspace", async () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());
    const principal = {
      type: "workspace_api_token" as const,
      role: "admin" as const,
      workspaceId: "workspace-a",
      tokenId: "token-a",
    };

    await expect(service.requirePermission({
      accountId: "account-1",
      principal,
      permission: "workspace.documents.manage",
      workspaceId: "workspace-b",
    })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });

    await expect(service.requirePermission({
      accountId: "account-1",
      principal,
      permission: "workspace.documents.manage",
      workspaceId: "workspace-a",
    })).resolves.toBeUndefined();
  });

  it("continues to authorize session users for another workspace in their account", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const user = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: user.id, role: "owner" });

    await expect(service.requirePermission({
      accountId: "account-1",
      principal: { type: "session_user", userId: user.id },
      permission: "workspace.documents.manage",
      workspaceId: "workspace-b",
    })).resolves.toBeUndefined();
  });

  it("resolves the preferred account membership for login", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const user = await userRepository.create({ email: "alice@example.com", passwordHash: "hash" });

    await membershipRepository.create({ accountId: "account-1", userId: user.id, role: "owner" });
    const preferred = await membershipRepository.create({ accountId: "account-2", userId: user.id, role: "member" });

    await expect(service.resolveLoginAccount(user.id, "account-2")).resolves.toMatchObject({
      accountId: preferred.accountId,
    });
  });

  it("defaults login resolution to the most recent active membership", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const user = await userRepository.create({ email: "alice@example.com", passwordHash: "hash" });

    await membershipRepository.create({ accountId: "account-1", userId: user.id, role: "owner" });
    const latest = await membershipRepository.create({ accountId: "account-2", userId: user.id, role: "member" });

    await expect(service.resolveLoginAccount(user.id)).resolves.toMatchObject({
      accountId: latest.accountId,
    });
  });

  it("rejects access when no active membership exists", async () => {
    const service = new AccountAccessService(new InMemoryAccountMembershipRepository(), createAuditService());

    await expect(service.requireActiveMembership("account-1", "user-1")).rejects.toMatchObject({
      statusCode: 401,
      code: "unauthorized",
    });
  });

  it("allows an owner to remove a member from the account", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const owner = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    const member = await userRepository.create({ email: "member@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: owner.id, role: "owner" });
    const targetMembership = await membershipRepository.create({ accountId: "account-1", userId: member.id, role: "member" });

    await expect(service.removeUserAccess({
      accountId: "account-1",
      actorUserId: owner.id,
      membershipId: targetMembership.id,
    })).resolves.toBeUndefined();

    await expect(membershipRepository.findActiveByAccountAndUser("account-1", member.id)).resolves.toBeNull();
  });

  it("rejects member-initiated removals", async () => {
    const userRepository = new InMemoryUserRepository();
    const membershipRepository = new InMemoryAccountMembershipRepository();
    membershipRepository.setUserRepository(userRepository);
    const service = new AccountAccessService(membershipRepository, createAuditService());
    const owner = await userRepository.create({ email: "owner@example.com", passwordHash: "hash" });
    const member = await userRepository.create({ email: "member@example.com", passwordHash: "hash" });
    await membershipRepository.create({ accountId: "account-1", userId: owner.id, role: "owner" });
    await membershipRepository.create({ accountId: "account-1", userId: member.id, role: "member" });

    await expect(service.removeUserAccess({
      accountId: "account-1",
      actorUserId: member.id,
      membershipId: (await membershipRepository.findActiveByAccountAndUser("account-1", owner.id))!.id,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });
  });
});
