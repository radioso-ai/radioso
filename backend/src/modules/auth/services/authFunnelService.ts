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

/**
 * The credential generation a sign-in read together with the proof it checked.
 * Password reset and federated recovery advance a user's generation in the
 * transaction that revokes their sessions and provider links, so a session or
 * link written for a generation the user no longer holds would outlive the
 * recovery meant to end it. Writes made for one land only while it is current.
 */
export interface CredentialGeneration {
  userId: string;
  generation: number;
}

/**
 * What a federated recovery did. Only a recovery that rotated the credentials
 * advances the generation; when verification won first the user is untouched
 * and the sign-in keeps the generation it read.
 */
type FederatedRecovery =
  | { recovered: true; displayName: string | null; credentialGeneration: number }
  | { recovered: false; displayName: string | null };

export interface AuthFunnelRepositoryPort {
  createRegistrationChallenge(input: {
    userId: string;
    accountId: string;
    verificationTokenId: string;
    verificationTokenHash: string;
    verificationExpiresAt: Date;
    pendingTicketId: string;
    pendingTokenHash: string;
    pendingExpiresAt: Date;
    requestIp: string | null;
    requestUserAgent: string | null;
  }): Promise<boolean>;
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
  completePasswordReset(input: {
    resetTokenHash: string;
    passwordHash: string;
    now: Date;
  }): Promise<{
    userId: string;
    email: string;
    displayName: string | null;
    revokedFederatedIdentities: number;
    /** The generation the reset advanced the user to. */
    credentialGeneration: number;
  } | null>;
  recoverFederatedUser(input: {
    userId: string;
    passwordHash: string;
    displayName: string | null;
    now: Date;
  }): Promise<FederatedRecovery | null>;
  /**
   * Writes a session only while the user holds the given generation. A recovery
   * still in flight is waited for, so one that commits first leaves nothing
   * written. Answers whether the session was written.
   */
  createSessionForCredential(input: {
    credential: CredentialGeneration;
    accountId: string;
    sessionId: string;
    sessionTokenHash: string;
    sessionExpiresAt: Date;
  }): Promise<boolean>;
  /**
   * Links, or refreshes the link of, a provider identity under the same rule as
   * `createSessionForCredential`. Answers whether the link was written.
   */
  linkFederatedIdentityForCredential(input: {
    credential: CredentialGeneration;
    provider: string;
    subject: string;
    providerEmail: string;
    authenticatedAt: Date;
  }): Promise<boolean>;
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

  async issueRegistrationChallenge(input: {
    userId: string;
    accountId: string;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<{
    pendingCookie: string;
    verification: { userId: string; tokenRecordId: string; token: string; issuedAt: Date };
  }> {
    const issuedAt = new Date();
    const verificationToken = randomBytes(32).toString("base64url");
    const pendingToken = randomBytes(32).toString("base64url");
    const verificationTokenId = randomUUID();
    const pendingExpiresAt = new Date(
      issuedAt.getTime() + this.dependencies.env.AUTH_PENDING_REGISTRATION_TTL_MINUTES * 60 * 1000,
    );
    const created = await this.dependencies.repository.createRegistrationChallenge({
      userId: input.userId,
      accountId: input.accountId,
      verificationTokenId,
      verificationTokenHash: sha256(verificationToken),
      verificationExpiresAt: new Date(
        issuedAt.getTime() + this.dependencies.env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES * 60 * 1000,
      ),
      pendingTicketId: randomUUID(),
      pendingTokenHash: sha256(pendingToken),
      pendingExpiresAt,
      requestIp: input.requestIp ?? null,
      requestUserAgent: input.requestUserAgent ?? null,
    });
    if (!created) throw unauthorized("Email verification is already complete");
    await this.dependencies.auditService.record({
      accountId: input.accountId,
      eventType: "auth.pending_registration.issue",
      eventStatus: "success",
      metadata: { userId: input.userId, expiresAt: pendingExpiresAt.toISOString() },
    });
    return {
      pendingCookie: serialize(PENDING_REGISTRATION_COOKIE_NAME, pendingToken, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: this.dependencies.env.AUTH_PENDING_REGISTRATION_TTL_MINUTES * 60,
      }),
      verification: { userId: input.userId, tokenRecordId: verificationTokenId, token: verificationToken, issuedAt },
    };
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
