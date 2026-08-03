import type { AbuseControlPolicy } from "../../security/services/abuseControlService.js";

import type { AudiencePulseAuditPort, AudiencePulseRefreshRateLimitPort } from "../contracts.js";

export const AUDIENCE_PULSE_REFRESH_RATE_LIMIT_SCOPE = "audience_pulse.refresh";

const audiencePulseRefreshRateLimit = {
  maxAttempts: 3,
  windowMs: 15 * 60 * 1000,
} as const;

export interface AudiencePulseRefreshRateLimiterDependencies {
  abuseControlService: {
    enforce(input: AbuseControlPolicy): Promise<unknown>;
  };
  auditService: AudiencePulseAuditPort;
}

const errorStatusCode = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
};

/** Durable account/workspace budget for explicit refreshes that hold the run lease. */
export class AudiencePulseRefreshRateLimiter implements AudiencePulseRefreshRateLimitPort {
  constructor(private readonly deps: AudiencePulseRefreshRateLimiterDependencies) {}

  async enforce(input: { accountId: string; workspaceId: string }): Promise<void> {
    const subjectKey = `${input.accountId}:${input.workspaceId}`;
    try {
      await this.deps.abuseControlService.enforce({
        scope: AUDIENCE_PULSE_REFRESH_RATE_LIMIT_SCOPE,
        subjectKey,
        limit: audiencePulseRefreshRateLimit.maxAttempts,
        windowMs: audiencePulseRefreshRateLimit.windowMs,
      });
    } catch (error) {
      const statusCode = errorStatusCode(error);
      if (statusCode === 429 || statusCode === 503) {
        void this.deps.auditService.record({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          eventType: statusCode === 429 ? "security.rate_limit_enforced" : "security.rate_limit_unavailable",
          eventStatus: statusCode === 429 ? "success" : "failure",
          metadata: {
            scope: AUDIENCE_PULSE_REFRESH_RATE_LIMIT_SCOPE,
            subjectKey,
          },
        }).catch(() => undefined);
      }
      throw error;
    }
  }
}
