import type { AuditService } from "../../audit/contracts/index.js";
import { sha256 } from "../domain/authPrimitives.js";

/** A session a sign-out ended. */
export interface EndedSession {
  sessionId: string;
  userId: string;
  accountId: string;
}

export interface SessionSignOutRepositoryPort {
  /**
   * Revokes the session, not yet revoked, whose token hashes to this value and names it; answers
   * null when there is none (an unknown token, or one already revoked), so a repeat is a no-op.
   */
  revokeByTokenHash(sessionTokenHash: string, revokedAt: Date): Promise<EndedSession | null>;
}

interface SessionSignOutDependencies {
  sessionRepository: SessionSignOutRepositoryPort;
  auditService: Pick<AuditService, "record">;
}

/**
 * Ends the session a browser presents. Signing out is idempotent: a request with no
 * cookie, an unknown token, or a session that already ended succeeds and records nothing,
 * because the caller's intent -- to hold no usable session -- is already met.
 *
 * The audit record is required, like the other successful auth events (login, password reset,
 * verification): the revoke commits first, so an audit write that fails answers a 5xx for a
 * session that has in fact ended. The route clears the cookie on that response too.
 */
export class SessionSignOutService {
  constructor(private readonly dependencies: SessionSignOutDependencies) {}

  async signOut(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken) {
      return;
    }

    const ended = await this.dependencies.sessionRepository.revokeByTokenHash(sha256(sessionToken), new Date());
    if (!ended) {
      return;
    }

    await this.dependencies.auditService.record({
      accountId: ended.accountId,
      eventType: "auth.logout",
      eventStatus: "success",
      metadata: { userId: ended.userId },
    });
  }
}
