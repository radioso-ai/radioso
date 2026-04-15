import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { anonymousRateLimiter, resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { createTestDependencies } from "../support/testApp.js";

const createMockReqRes = (locals: Record<string, unknown> = {}) => {
  const req = {} as Request;
  let responseBody: unknown = undefined;
  let responseStatus = 200;
  let nextError: unknown = undefined;
  const res = {
    locals,
    status(code: number) {
      responseStatus = code;
      return this;
    },
    json(body: unknown) {
      responseBody = body;
      return this;
    },
  } as unknown as Response;
  let nextCalled = false;
  const next: NextFunction = (error?: unknown) => {
    nextError = error;
    if (error instanceof AppError) {
      responseStatus = error.statusCode;
      responseBody = {
        code: error.code,
        ...error.details,
      };
      return;
    }
    nextCalled = true;
  };
  return {
    req,
    res,
    next,
    getStatus: () => responseStatus,
    getBody: () => responseBody,
    getError: () => nextError,
    wasNextCalled: () => nextCalled,
  };
};

const middleware = () => anonymousRateLimiter(createTestDependencies().dependencies);

describe("anonymousRateLimiter", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  it("allows messages under the limit", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-1",
      anonymousRateLimit: 5,
    });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("rejects at the limit with 429 and retryAfterSeconds", async () => {
    const limit = 3;
    const sessionId = "session-limit-test";
    const rateLimiter = middleware();

    // Send messages up to the limit
    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-1",
        anonymousSessionId: sessionId,
        anonymousRateLimit: limit,
      });
      await rateLimiter(req, res, next);
    }

    // The next one should be rejected
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: sessionId,
      anonymousRateLimit: limit,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
    expect((getBody() as any).code).toBe("rate_limit_exceeded");
    expect((getBody() as any).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("handles concurrent sessions independently", async () => {
    const limit = 2;
    const rateLimiter = middleware();

    // Fill session A
    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-1",
        anonymousSessionId: "session-a",
        anonymousRateLimit: limit,
      });
      await rateLimiter(req, res, next);
    }

    // Session B should still be allowed
    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-b",
      anonymousRateLimit: limit,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("passes through when no anonymousSessionId is set", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({});

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("respects different limits per request", async () => {
    const sessionId = "session-diff-limits";
    const rateLimiter = middleware();

    // First request with limit=1
    const { req: req1, res: res1, next: next1 } = createMockReqRes({
      anonymousSessionId: sessionId,
      workspaceId: "workspace-1",
      anonymousRateLimit: 1,
    });
    await rateLimiter(req1, res1, next1);

    // Second request — should be rejected even though a higher limit could allow it
    const { req, res, next, getStatus, wasNextCalled } = createMockReqRes({
      anonymousSessionId: sessionId,
      workspaceId: "workspace-1",
      anonymousRateLimit: 1,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
  });

  it("scopes rate limiting by workspace as well as session", async () => {
    const sessionId = "shared-session";
    const rateLimiter = middleware();

    const { req: req1, res: res1, next: next1 } = createMockReqRes({
      workspaceId: "workspace-a",
      anonymousSessionId: sessionId,
      anonymousRateLimit: 1,
    });
    await rateLimiter(req1, res1, next1);

    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-b",
      anonymousSessionId: sessionId,
      anonymousRateLimit: 1,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });
});
