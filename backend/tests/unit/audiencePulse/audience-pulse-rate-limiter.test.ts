import { describe, expect, it } from "vitest";

import type { AbuseControlPolicy } from "../../../src/modules/security/services/abuseControlService.js";
import {
  AudiencePulseRefreshRateLimiter,
  type AudiencePulseRefreshRateLimiterDependencies,
} from "../../../src/modules/audiencePulse/infra/audiencePulseRefreshRateLimiter.js";

describe("Audience Pulse refresh rate limiter", () => {
  it("owns its budget in product policy rather than environment configuration", async () => {
    const enforced: AbuseControlPolicy[] = [];
    const limiter = new AudiencePulseRefreshRateLimiter({
      abuseControlService: {
        async enforce(input: AbuseControlPolicy) {
          enforced.push(input);
        },
      },
      auditService: { async record() {} },
    } satisfies AudiencePulseRefreshRateLimiterDependencies);

    await limiter.enforce({ accountId: "account-1", workspaceId: "workspace-1" });

    expect(enforced).toEqual([{
      scope: "audience_pulse.refresh",
      subjectKey: "account-1:workspace-1",
      limit: 3,
      windowMs: 15 * 60 * 1000,
    }]);
  });

  it("keeps durable rate-limit enforcement auditable", async () => {
    const rateLimitError = Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 });
    const auditEvents: Array<{ eventType: string; eventStatus: string; metadata?: Record<string, unknown> }> = [];
    const limiter = new AudiencePulseRefreshRateLimiter({
      abuseControlService: {
        async enforce() { throw rateLimitError; },
      },
      auditService: {
        async record(input) { auditEvents.push(input); },
      },
    });

    await expect(limiter.enforce({ accountId: "account-1", workspaceId: "workspace-1" }))
      .rejects.toBe(rateLimitError);

    expect(auditEvents).toEqual([{
      accountId: "account-1",
      workspaceId: "workspace-1",
      eventType: "security.rate_limit_enforced",
      eventStatus: "success",
      metadata: {
        scope: "audience_pulse.refresh",
        subjectKey: "account-1:workspace-1",
      },
    }]);
  });
});
