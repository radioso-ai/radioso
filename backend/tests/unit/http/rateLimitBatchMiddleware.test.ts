import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicVoiceSessionStartRateLimiter } from "../../../src/app/http/middleware/publicVoiceSessionRateLimiter.js";
import { createRateLimitBatchMiddleware } from "../../../src/app/http/middleware/rateLimit.js";
import type { AbuseControlDecision } from "../../../src/modules/security/contracts/abuseControl.js";
import { AbuseControlService } from "../../../src/modules/security/services/abuseControlService.js";
import { InMemoryAbuseControlRepository } from "../../support/fakes.js";

interface Outcome {
  error: unknown;
  headers: Record<string, string>;
}

const respond = async (
  middlewares: readonly ((req: Request, res: Response, next: NextFunction) => unknown)[],
  locals: Record<string, unknown> = {},
): Promise<Outcome> => {
  const headers: Record<string, string> = {};
  const req = {} as Request;
  const res = { locals, setHeader: (name: string, value: string) => { headers[name] = value; } } as unknown as Response;
  let error: unknown;
  for (const middleware of middlewares) {
    let advanced = false;
    await middleware(req, res, (nextError?: unknown) => {
      advanced = true;
      error = nextError;
    });
    if (!advanced || error) break;
  }
  return { error, headers };
};

const auditService = { record: vi.fn().mockResolvedValue(undefined) };

describe("rate-limit batch middleware", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advertises the budget that refills last when two are equally spent", async () => {
    const soon: AbuseControlDecision = { limit: 30, remaining: 0, resetAtMs: Date.now() + 20_000, resetAfterSeconds: 20 };
    const later: AbuseControlDecision = { limit: 3, remaining: 0, resetAtMs: Date.now() + 200_000, resetAfterSeconds: 200 };
    const middlewareReturning = (decisions: AbuseControlDecision[]) => createRateLimitBatchMiddleware({
      service: { enforceBatch: vi.fn().mockResolvedValue(decisions) },
      auditService,
      resolvePolicies: () => [
        { scope: "a", subjectKey: "a", limit: 1, windowMs: 60_000 },
        { scope: "b", subjectKey: "b", limit: 1, windowMs: 60_000 },
      ],
    });

    for (const decisions of [[soon, later], [later, soon]]) {
      const { headers } = await respond([middlewareReturning(decisions)]);
      expect(headers).toMatchObject({ "RateLimit-Limit": "3", "RateLimit-Remaining": "0", "RateLimit-Reset": "200" });
    }
  });

  it("admits a voice start a full window after the last accepted one, through the batch the route spends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-02T16:35:03.000Z").getTime();
    const repository = new InMemoryAbuseControlRepository();
    const limiter = publicVoiceSessionStartRateLimiter({
      env: {
        PUBLIC_VOICE_SESSION_START_RATE_LIMIT_MAX_ATTEMPTS: 3,
        PUBLIC_VOICE_SESSION_START_RATE_LIMIT_WINDOW_MS: 600_000,
        PUBLIC_VOICE_SESSION_START_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 3,
        PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 30,
        PUBLIC_VOICE_SESSION_START_WORKSPACE_RATE_LIMIT_WINDOW_MS: 60_000,
      },
      abuseControlService: new AbuseControlService(repository),
      auditService,
    });
    const startAt = (seconds: number) => {
      vi.setSystemTime(start + seconds * 1_000);
      return respond(limiter, {
        workspaceId: "workspace-1",
        chatSessionId: `session-${seconds}`,
        requestSource: { address: "203.0.113.7", digest: "source-1" },
      });
    };
    const sourceEntry = () => repository.find("public.voice.session_start.source", "workspace-1:source:source-1");

    for (const seconds of [0, 1, 31]) {
      expect((await startAt(seconds)).error).toBeUndefined();
    }
    const refused = await startAt(546);
    expect(refused.error).toMatchObject({ statusCode: 429, details: { resetAtMs: start + 1_146_000 } });
    expect(refused.headers).toMatchObject({ "Retry-After": "600" });
    // A refused batch writes nothing: the source budget still holds the three accepted starts.
    expect(await sourceEntry()).toMatchObject({ attemptCount: 3, blockedUntil: null, windowStartedAt: new Date(start) });

    const admitted = await startAt(1_156);
    expect(admitted.error).toBeUndefined();
    expect(admitted.headers).toMatchObject({ "RateLimit-Remaining": "1" });
    expect(await sourceEntry()).toMatchObject({
      attemptCount: 1,
      previousAttemptCount: 3,
      windowStartedAt: new Date(start + 600_000),
    });
  });
});
