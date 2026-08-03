import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import type { AbuseControlPolicy } from "../../../src/modules/security/services/abuseControlService.js";
import {
  createAudiencePulseRefreshRateLimiter,
  type AudiencePulseRefreshRateLimitDependencies,
} from "../../../src/app/http/middleware/audiencePulseRefreshRateLimiter.js";

describe("Audience Pulse refresh rate limiter", () => {
  it("owns its budget in product policy rather than environment configuration", async () => {
    const enforced: AbuseControlPolicy[] = [];
    const middleware = createAudiencePulseRefreshRateLimiter({
      abuseControlService: {
        async enforce(input: AbuseControlPolicy) {
          enforced.push(input);
        },
      },
      auditService: { async record() {} },
    } as unknown as AudiencePulseRefreshRateLimitDependencies);
    const next = vi.fn();

    await middleware(
      {} as Request,
      { locals: { accountId: "account-1", workspaceId: "workspace-1" } } as unknown as Response,
      next,
    );

    expect(enforced).toEqual([{
      scope: "audience_pulse.refresh",
      subjectKey: "account-1:workspace-1",
      limit: 3,
      windowMs: 15 * 60 * 1000,
    }]);
    expect(next).toHaveBeenCalledOnce();
  });
});
