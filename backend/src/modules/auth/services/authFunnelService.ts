import { randomBytes, randomUUID } from "node:crypto";
import { serialize } from "cookie";

import type { Env } from "../../../app/config/env.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { unauthorized } from "../../../shared/domain/errors.js";
import {
  generateSessionToken,
  serializeSessionCookie,
  sha256,
} from "../domain/authPrimitives.js";

export const PENDING_REGISTRATION_COOKIE_NAME = "radioso_pending_registration";

interface AuthFunnelClaim {
  userId: string;
  accountId: string;
}

export interface AuthFunnelRepositoryPort {
  createPendingTicket(input: {
    id: string;
    userId: string;
    accountId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
  verifyEmailAndCreateSession(input: {
    verificationTokenHash: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<AuthFunnelClaim | null>;
  exchangePendingTicket(input: {
    pendingTokenHash: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
    now: Date;
  }): Promise<AuthFunnelClaim | null>;
}

interface PreparedSession {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  cookie: string;
}

export class AuthFunnelService {
  constructor(private readonly dependencies: {
    env: Env;
    repository: AuthFunnelRepositoryPort;
    auditService: AuditService;
  }) {}

  async issuePendingTicket(input: { userId: string; accountId: string }): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + this.dependencies.env.AUTH_PENDING_REGISTRATION_TTL_MINUTES * 60 * 1000,
    );
    await this.dependencies.repository.createPendingTicket({
      id: randomUUID(),
      userId: input.userId,
      accountId: input.accountId,
      tokenHash: sha256(token),
      expiresAt,
    });
    await this.dependencies.auditService.record({
      accountId: input.accountId,
      eventType: "auth.pending_registration.issue",
      eventStatus: "success",
      metadata: { userId: input.userId, expiresAt: expiresAt.toISOString() },
    });
    return serialize(PENDING_REGISTRATION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: this.dependencies.env.AUTH_PENDING_REGISTRATION_TTL_MINUTES * 60,
    });
  }

  async verify(input: { token: string }): Promise<{ verified: true; sessionCookie: string }> {
    const now = new Date();
    const session = this.prepareSession(now);
    const claim = await this.dependencies.repository.verifyEmailAndCreateSession({
      verificationTokenHash: sha256(input.token),
      sessionId: session.id,
      sessionTokenHash: session.tokenHash,
      sessionExpiresAt: session.expiresAt,
      now,
    });
    if (!claim) {
      await this.dependencies.auditService.record({
        eventType: "auth.email_verification.verify",
        eventStatus: "failure",
        metadata: { reason: "invalid_expired_or_used" },
      });
      throw unauthorized("Email verification link is invalid or expired");
    }
    await this.dependencies.auditService.record({
      accountId: claim.accountId,
      eventType: "auth.email_verification.verify",
      eventStatus: "success",
      metadata: { userId: claim.userId },
    });
    return { verified: true, sessionCookie: session.cookie };
  }

  async exchangePendingTicket(token: string | undefined): Promise<
    | { ready: false }
    | { ready: true; sessionCookie: string; pendingCookieClear: string }
  > {
    if (!token) {
      return { ready: false };
    }
    const now = new Date();
    const session = this.prepareSession(now);
    const claim = await this.dependencies.repository.exchangePendingTicket({
      pendingTokenHash: sha256(token),
      sessionId: session.id,
      sessionTokenHash: session.tokenHash,
      sessionExpiresAt: session.expiresAt,
      now,
    });
    if (!claim) {
      return { ready: false };
    }
    await this.dependencies.auditService.record({
      accountId: claim.accountId,
      eventType: "auth.pending_registration.exchange",
      eventStatus: "success",
      metadata: { userId: claim.userId },
    });
    return {
      ready: true,
      sessionCookie: session.cookie,
      pendingCookieClear: serialize(PENDING_REGISTRATION_COOKIE_NAME, "", {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      }),
    };
  }

  private prepareSession(now: Date): PreparedSession {
    const token = generateSessionToken();
    return {
      id: randomUUID(),
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + this.dependencies.env.SESSION_TTL_HOURS * 60 * 60 * 1000),
      cookie: serializeSessionCookie(token, this.dependencies.env),
    };
  }
}
