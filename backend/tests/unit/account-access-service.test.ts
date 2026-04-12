import { describe, expect, it } from "vitest";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import {
  createAuditService,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
} from "../support/fakes.js";

describe("AccountAccessService", () => {
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
