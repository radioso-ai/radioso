import { describe, expect, it } from "vitest";

import { hashStaffPassword, hashStaffSessionToken } from "./staffCrypto.js";
import { StaffAuthService } from "./staffAuthService.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";

const activeUser = async () => ({
  id: "11111111-1111-1111-1111-111111111111",
  email: "owner@example.com",
  name: "Owner",
  passwordHash: await hashStaffPassword("password-123"),
  role: "owner" as const,
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastLoginAt: null,
});

const createRepositories = async (overrides: { status?: "active" | "disabled" } = {}) => {
  const user = { ...(await activeUser()), status: overrides.status ?? "active" };
  const sessions = new Map<string, {
    id: string;
    staffId: string;
    sessionTokenHash: string;
    expiresAt: Date;
    revokedAt: Date | null;
  }>();
  const users: StaffUserRepository = {
    async findByEmail(email) {
      return email.toLowerCase() === user.email ? user : null;
    },
    async findById(id) {
      return id === user.id ? user : null;
    },
    async create() {
      throw new Error("not used");
    },
    async updatePassword() {
      throw new Error("not used");
    },
    async setRole() {
      throw new Error("not used");
    },
    async setStatus() {
      throw new Error("not used");
    },
    async touchLastLogin() {},
  };
  const staffSessions: StaffSessionRepository = {
    async create(input) {
      const row = {
        id: "22222222-2222-2222-2222-222222222222",
        staffId: input.staffId,
        sessionTokenHash: input.sessionTokenHash,
        expiresAt: input.expiresAt,
        revokedAt: null,
      };
      sessions.set(input.sessionTokenHash, row);
      return row;
    },
    async findActiveByTokenHash(tokenHash) {
      const row = sessions.get(tokenHash);
      if (!row || row.revokedAt || row.expiresAt <= new Date()) {
        return null;
      }
      return row;
    },
    async touch() {},
    async revoke(tokenHash) {
      const row = sessions.get(tokenHash);
      if (row) {
        row.revokedAt = new Date();
      }
    },
  };
  return { users, staffSessions, sessions, user };
};

describe("StaffAuthService", () => {
  it("creates a session on valid login", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, { ttlHours: 2 });

    const result = await service.login({ email: "OWNER@example.com", password: "password-123" });

    expect(result.staff).toMatchObject({ id: repositories.user.id, role: "owner" });
    expect(hashStaffSessionToken(result.sessionToken)).toBe([...repositories.sessions.keys()][0]);
  });

  it("rejects wrong passwords and disabled users", async () => {
    const activeRepositories = await createRepositories();
    const activeService = new StaffAuthService(activeRepositories.users, activeRepositories.staffSessions);

    await expect(activeService.login({ email: "owner@example.com", password: "wrong" }))
      .rejects.toMatchObject({ statusCode: 401 });

    const disabledRepositories = await createRepositories({ status: "disabled" });
    const disabledService = new StaffAuthService(disabledRepositories.users, disabledRepositories.staffSessions);

    await expect(disabledService.login({ email: "owner@example.com", password: "password-123" }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("authenticates active sessions and rejects unknown, expired, or revoked tokens", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions);
    const login = await service.login({ email: "owner@example.com", password: "password-123" });

    await expect(service.authenticateStaffSession(login.sessionToken))
      .resolves.toMatchObject({ staff: { id: repositories.user.id, role: "owner" } });
    await expect(service.authenticateStaffSession("missing-token"))
      .rejects.toMatchObject({ statusCode: 401 });

    const tokenHash = [...repositories.sessions.keys()][0];
    repositories.sessions.get(tokenHash)!.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.authenticateStaffSession(login.sessionToken))
      .rejects.toMatchObject({ statusCode: 401 });
    repositories.sessions.get(tokenHash)!.expiresAt = new Date(Date.now() + 60_000);

    await service.revoke(login.sessionToken);

    await expect(service.authenticateStaffSession(login.sessionToken))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
