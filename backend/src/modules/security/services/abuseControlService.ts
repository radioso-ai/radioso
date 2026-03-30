import { AppError, tooManyRequests, serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AbuseControlEntry, AbuseControlRepositoryPort } from "../../../db/repositories/abuseControlRepository.js";

export interface AbuseControlPolicy {
  scope: string;
  subjectKey: string;
  limit: number;
  windowMs: number;
  blockMs?: number;
  now?: Date;
}

export interface AbuseControlResult {
  enforced: boolean;
  retryAfterSeconds?: number;
  entry: AbuseControlEntry;
}

export class AbuseControlService {
  constructor(private readonly repository: AbuseControlRepositoryPort) {}

  async enforce(policy: AbuseControlPolicy): Promise<AbuseControlResult> {
    const now = policy.now ?? new Date();
    const blockMs = policy.blockMs ?? policy.windowMs;

    try {
      const existing = await this.repository.find(policy.scope, policy.subjectKey);

      if (existing?.blockedUntil && existing.blockedUntil.getTime() > now.getTime()) {
        throw tooManyRequests("Rate limit exceeded. Please wait before trying again.", {
          retryAfterSeconds: this.retryAfterSeconds(existing.blockedUntil, now),
        });
      }

      const withinActiveWindow =
        existing && now.getTime() - existing.windowStartedAt.getTime() < policy.windowMs;
      const nextAttemptCount = withinActiveWindow ? existing!.attemptCount + 1 : 1;
      const blockedUntil = nextAttemptCount > policy.limit
        ? new Date(now.getTime() + blockMs)
        : null;

      const saved = await this.repository.save({
        scope: policy.scope,
        subjectKey: policy.subjectKey,
        attemptCount: nextAttemptCount,
        windowStartedAt: withinActiveWindow ? existing!.windowStartedAt : now,
        blockedUntil,
      });

      void this.repository.deleteExpired(now).catch(() => undefined);

      if (blockedUntil) {
        throw tooManyRequests("Rate limit exceeded. Please wait before trying again.", {
          retryAfterSeconds: this.retryAfterSeconds(blockedUntil, now),
        });
      }

      return {
        enforced: false,
        entry: saved,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw serviceUnavailable("Abuse control enforcement is unavailable");
    }
  }

  private retryAfterSeconds(blockedUntil: Date, now: Date): number {
    return Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000));
  }
}
