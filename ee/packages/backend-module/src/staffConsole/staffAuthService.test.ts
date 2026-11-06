import { describe, expect, it, vi } from "vitest";

import { hashStaffPassword, hashStaffSessionToken } from "./staffCrypto.js";
import { StaffAuthService, staffSessionIdleTimeoutMs } from "./staffAuthService.js";
import type { StaffSessionRepository, StaffUserRepository } from "./staffRepository.js";
import { StaffSecurityEvents } from "./staffSecurityEvents.js";

const activeUser = async () => ({
  id: "11111111-1111-1111-1111-111111111111",
  email: "owner@example.com",
  name: "Owner",
  passwordHash: await hashStaffPassword("password-123"),
  googleSubject: null,
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
    lastSeenAt: Date;
    revokedAt: Date | null;
  }>();
  const users: StaffUserRepository = {
    async findByEmail(email) {
      return email.toLowerCase() === user.email ? user : null;
    },
    async findById(id) {
      return id === user.id ? user : null;
    },
    async listStaff() {
      return [user];
    },
    async countActiveOwners() {
      return 1;
    },
    async create() {
      throw new Error("not used");
    },
    async resetCredentials() {
      throw new Error("not used");
    },
    async bindGoogleSubject() {
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
        lastSeenAt: new Date(),
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
    async touch(tokenHash) {
      const row = sessions.get(tokenHash);
      if (row) {
        row.lastSeenAt = new Date();
      }
    },
    async revoke(tokenHash) {
      const row = sessions.get(tokenHash);
      if (row) {
        row.revokedAt = new Date();
      }
    },
    async revokeAllForStaff() {
      return 0;
    },
  };
  return { users, staffSessions, sessions, user };
};

const createEvents = () => {
  const record = vi.fn(async () => undefined);
  return { record, events: new StaffSecurityEvents({ record }) };
};

describe("StaffAuthService", () => {
  it("creates a session on valid login", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, createEvents().events, { ttlHours: 2 });

    const result = await service.login({ email: "OWNER@example.com", password: "password-123" });

    expect(result.staff).toMatchObject({ id: repositories.user.id, role: "owner" });
    expect(hashStaffSessionToken(result.sessionToken)).toBe([...repositories.sessions.keys()][0]);
  });

  it("rejects wrong passwords and disabled users", async () => {
    const activeRepositories = await createRepositories();
    const activeService = new StaffAuthService(activeRepositories.users, activeRepositories.staffSessions, createEvents().events);

    await expect(activeService.login({ email: "owner@example.com", password: "wrong" }))
      .rejects.toMatchObject({ statusCode: 401 });

    const disabledRepositories = await createRepositories({ status: "disabled" });
    const disabledService = new StaffAuthService(disabledRepositories.users, disabledRepositories.staffSessions, createEvents().events);

    await expect(disabledService.login({ email: "owner@example.com", password: "password-123" }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it("gives an unknown address and a wrong password the same answer", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, createEvents().events);

    const unknown = await service.login({ email: "nobody@example.com", password: "wrong" }).catch((error: unknown) => error);
    const wrong = await service.login({ email: "owner@example.com", password: "wrong" }).catch((error: unknown) => error);

    expect(unknown).toMatchObject({ statusCode: 401, code: "unauthorized", message: "Unauthorized" });
    expect(wrong).toMatchObject({ statusCode: 401, code: "unauthorized", message: "Unauthorized" });
  });

  it("records one sign-in event per attempt, naming why it failed", async () => {
    const repositories = await createRepositories();
    const { events, record } = createEvents();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, events);

    await service.login({ email: "owner@example.com", password: "password-123" });
    await service.login({ email: "owner@example.com", password: "wrong" }).catch(() => undefined);
    await service.login({ email: "nobody@example.com", password: "wrong" }).catch(() => undefined);

    expect(record.mock.calls).toEqual([
      [expect.objectContaining({
        eventType: "staff.auth.login",
        eventStatus: "success",
        metadata: { method: "password", targetStaffId: repositories.user.id },
      })],
      [expect.objectContaining({
        eventType: "staff.auth.login",
        eventStatus: "failure",
        metadata: { method: "password", reason: "wrong_password", targetStaffId: repositories.user.id },
      })],
      [expect.objectContaining({
        eventType: "staff.auth.login",
        eventStatus: "failure",
        metadata: { method: "password", reason: "unknown_email" },
      })],
    ]);
  });

  it("lets a sign-in through when the audit write fails", async () => {
    const repositories = await createRepositories();
    const warn = vi.fn();
    const events = new StaffSecurityEvents(
      { record: vi.fn(async () => { throw new Error("audit unavailable"); }) },
      { warn },
    );
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, events);

    await expect(service.login({ email: "owner@example.com", password: "password-123" }))
      .resolves.toMatchObject({ staff: { id: repositories.user.id } });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "staff_console.audit_write_failed" }),
      expect.any(String),
    );
  });

  it("authenticates active sessions and rejects unknown, expired, or revoked tokens", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, createEvents().events);
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

  it("ends a session left idle for thirty minutes, and activity keeps one alive", async () => {
    const repositories = await createRepositories();
    const service = new StaffAuthService(repositories.users, repositories.staffSessions, createEvents().events);
    const login = await service.login({ email: "owner@example.com", password: "password-123" });
    const session = repositories.sessions.get([...repositories.sessions.keys()][0])!;

    expect(staffSessionIdleTimeoutMs).toBe(30 * 60 * 1000);

    session.lastSeenAt = new Date(Date.now() - staffSessionIdleTimeoutMs + 60_000);
    await expect(service.authenticateStaffSession(login.sessionToken))
      .resolves.toMatchObject({ staff: { id: repositories.user.id } });
    expect(session.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    session.lastSeenAt = new Date(Date.now() - staffSessionIdleTimeoutMs - 1_000);
    await expect(service.authenticateStaffSession(login.sessionToken))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
