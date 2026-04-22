import { describe, expect, it } from "vitest";

import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { verifyPassword } from "../../src/modules/auth/domain/authPrimitives.js";
import { PasswordResetService } from "../../src/modules/auth/services/passwordResetService.js";
import type {
  PasswordResetTokenRecord,
  PasswordResetTokenRepositoryPort,
} from "../../src/db/repositories/passwordResetTokenRepository.js";
import type { SessionRecord, SessionRepositoryPort } from "../../src/modules/auth/services/authService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  InMemoryAccountMembershipRepository,
  InMemoryAccountRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  createAuditService,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";

class InMemoryPasswordResetTokenRepository implements PasswordResetTokenRepositoryPort {
  readonly items = new Map<string, PasswordResetTokenRecord>();

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const record: PasswordResetTokenRecord = {
      id: `reset-${this.items.size + 1}`,
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      usedAt: null,
      createdAt: new Date(Date.now() + this.items.size),
      requestIp: params.requestIp ?? null,
      requestUserAgent: params.requestUserAgent ?? null,
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async findLatestActiveByUserId(userId: string, now: Date): Promise<PasswordResetTokenRecord | null> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && item.usedAt === null && item.expiresAt > now)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async markUsed(id: string, usedAt: Date): Promise<void> {
    const record = this.items.get(id);
    if (record) {
      record.usedAt = usedAt;
    }
  }

  async markAllActiveForUserUsed(userId: string, usedAt: Date): Promise<void> {
    for (const record of this.items.values()) {
      if (record.userId === userId && record.usedAt === null && record.expiresAt > usedAt) {
        record.usedAt = usedAt;
      }
    }
  }
}

class TrackingSessionRepository implements SessionRepositoryPort {
  readonly items = new Map<string, SessionRecord>();
  readonly revokedUserIds: string[] = [];

  async create(params: { userId: string; accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: `session-${this.items.size + 1}`,
      userId: params.userId,
      accountId: params.accountId,
      sessionTokenHash: params.sessionTokenHash,
      createdAt: new Date(),
      expiresAt: params.expiresAt,
      lastSeenAt: new Date(),
      revokedAt: null,
    };
    this.items.set(record.id, record);
    return record;
  }

  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null> {
    return [...this.items.values()].find(
      (item) => item.sessionTokenHash === sessionTokenHash && item.expiresAt > now && item.revokedAt === null,
    ) ?? null;
  }

  async touch(sessionId: string, lastSeenAt: Date): Promise<void> {
    const record = this.items.get(sessionId);
    if (record) {
      record.lastSeenAt = lastSeenAt;
    }
  }

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    this.revokedUserIds.push(userId);
    let count = 0;
    for (const record of this.items.values()) {
      if (record.userId === userId && record.revokedAt === null) {
        record.revokedAt = revokedAt;
        count += 1;
      }
    }
    return count;
  }
}

class RecordingEmailService {
  readonly messages: Array<{ to: string; resetUrl: string }> = [];

  async sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void> {
    this.messages.push(input);
  }
}

const createPasswordResetService = async () => {
  const env = {
    ...createTestEnv(),
    APP_BASE_URL: "http://localhost:3000",
    PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
  };
  const auditService = createAuditService();
  const accountRepository = new InMemoryAccountRepository();
  const userRepository = new InMemoryUserRepository();
  const accountMembershipRepository = new InMemoryAccountMembershipRepository();
  accountMembershipRepository.setUserRepository(userRepository);
  const accountAccessService = new AccountAccessService(accountMembershipRepository, auditService);
  const workspaceService = new WorkspaceService(new InMemoryWorkspaceRepository(), auditService);
  const sessionRepository = new TrackingSessionRepository();
  const passwordResetTokenRepository = new InMemoryPasswordResetTokenRepository();
  const emailService = new RecordingEmailService();

  const account = await accountRepository.create({
    name: "Reset Organization",
    email: "reset@example.com",
    passwordHash: "legacy-account-hash",
  });
  const user = await userRepository.create({
    id: account.id,
    email: "reset@example.com",
    passwordHash: account.passwordHash,
  });
  await accountAccessService.ensureMembership({
    accountId: account.id,
    userId: user.id,
    role: "owner",
  });
  await workspaceService.createDefault(account.id);

  const service = new PasswordResetService({
    env,
    auditService,
    accountRepository,
    accountAccessService,
    emailService,
    passwordResetTokenRepository,
    sessionRepository,
    userRepository,
    workspaceService,
  });

  return {
    service,
    user,
    auditService,
    emailService,
    passwordResetTokenRepository,
    sessionRepository,
    userRepository,
  };
};

describe("PasswordResetService", () => {
  it("creates a reset token and sends email for a known user", async () => {
    const { service, emailService, passwordResetTokenRepository, user } = await createPasswordResetService();

    const response = await service.requestReset({
      email: "reset@example.com",
      requestIp: "127.0.0.1",
      requestUserAgent: "vitest",
    });

    expect(response).toEqual({ accepted: true });
    expect(emailService.messages).toHaveLength(1);
    expect(emailService.messages[0]?.to).toBe("reset@example.com");
    expect(emailService.messages[0]?.resetUrl).toContain("http://localhost:3000/reset-password?token=");
    const activeToken = await passwordResetTokenRepository.findLatestActiveByUserId(user.id, new Date());
    expect(activeToken?.requestIp).toBe("127.0.0.1");
    expect(activeToken?.requestUserAgent).toBe("vitest");
  });

  it("returns the same accepted response for an unknown user without sending email", async () => {
    const { service, emailService, passwordResetTokenRepository } = await createPasswordResetService();

    const response = await service.requestReset({
      email: "missing@example.com",
      requestIp: "127.0.0.1",
    });

    expect(response).toEqual({ accepted: true });
    expect(emailService.messages).toHaveLength(0);
    expect(passwordResetTokenRepository.items.size).toBe(0);
  });

  it("rejects stale tokens after a newer request is issued", async () => {
    const { service, emailService } = await createPasswordResetService();

    await service.requestReset({ email: "reset@example.com" });
    await service.requestReset({ email: "reset@example.com" });

    const staleToken = new URL(emailService.messages[0]!.resetUrl).searchParams.get("token");

    await expect(
      service.confirmReset({
        token: staleToken!,
        password: "newsecurepassword",
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("updates the password, revokes existing sessions, and issues a fresh session on success", async () => {
    const {
      service,
      emailService,
      passwordResetTokenRepository,
      sessionRepository,
      user,
      userRepository,
    } = await createPasswordResetService();

    await sessionRepository.create({
      userId: user.id,
      accountId: user.id,
      sessionTokenHash: "old-session",
      expiresAt: new Date(Date.now() + 60_000),
    });

    await service.requestReset({ email: "reset@example.com" });
    const token = new URL(emailService.messages[0]!.resetUrl).searchParams.get("token");

    const result = await service.confirmReset({
      token: token!,
      password: "newsecurepassword",
    });

    const updatedUser = await userRepository.findById(user.id);
    expect(await verifyPassword("newsecurepassword", updatedUser!.passwordHash)).toBe(true);
    expect(sessionRepository.revokedUserIds).toEqual([user.id]);
    expect(result.accountId).toBe(user.id);
    expect(result.workspaceId).toBeTruthy();
    expect(result.sessionCookie).toContain("radioso_session=");
    const usedToken = await passwordResetTokenRepository.findByTokenHash(passwordResetTokenRepository.items.get("reset-1")!.tokenHash);
    expect(usedToken?.usedAt).toBeTruthy();
  });
});
