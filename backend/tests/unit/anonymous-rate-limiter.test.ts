import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { anonymousRateLimiters, resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { createTestDependencies } from "../support/testApp.js";

const createMockReqRes = (
  locals: Record<string, unknown> = {},
  options: { ip?: string; forwardedFor?: string } = {},
) => {
  const req = {
    ip: options.ip ?? "203.0.113.10",
    socket: { remoteAddress: options.ip ?? "203.0.113.10" },
    get(name: string) {
      return name.toLowerCase() === "x-forwarded-for" ? options.forwardedFor : undefined;
    },
  } as unknown as Request;
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
        ...(error.details && typeof error.details === "object" ? error.details : {}),
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

const middleware = () => anonymousRateLimiters(createTestDependencies().dependencies)[0];

describe("anonymousRateLimiter", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  it("allows messages under the limit", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-1",
    });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("rejects at the limit with 429 and retryAfterSeconds", async () => {
    const sessionId = "session-limit-test";
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    // Send messages up to the limit
    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-1",
        anonymousSessionId: sessionId,
      });
      await rateLimiter(req, res, next);
    }

    // The next one should be rejected
    const { req, res, next, getStatus, getBody, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: sessionId,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
    expect((getBody() as any).code).toBe("rate_limit_exceeded");
    expect((getBody() as any).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("handles request sources independently", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-1",
        anonymousSessionId: "session-a",
      }, { ip: "203.0.113.10" });
      await rateLimiter(req, res, next);
    }

    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-b",
    }, { ip: "203.0.113.11" });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("uses cookie-backed browser ids independently behind the same request source", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    const { req: firstReq, res: firstRes, next: firstNext } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-a",
      anonymousRateLimitId: "browser-a",
      anonymousRateLimitIdFromCookie: true,
    }, { ip: "203.0.113.50" });
    await rateLimiter(firstReq, firstRes, firstNext);

    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-b",
      anonymousRateLimitId: "browser-b",
      anonymousRateLimitIdFromCookie: true,
    }, { ip: "203.0.113.50" });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("does not reset the rate-limit bucket when the anonymous session id changes", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-1",
        anonymousSessionId: "session-before-reset",
        anonymousRateLimitId: "browser-before-reset",
        anonymousRateLimitIdFromCookie: true,
      }, { ip: "203.0.113.20" });
      await rateLimiter(req, res, next);
    }

    const { req, res, next, getStatus, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-after-reset",
      anonymousRateLimitId: "browser-before-reset",
      anonymousRateLimitIdFromCookie: true,
    }, { ip: "203.0.113.20" });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
  });

  it("passes through when no anonymousSessionId is set", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({});

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("scopes rate limiting by workspace as well as session", async () => {
    const sessionId = "shared-session";
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-a",
        anonymousSessionId: sessionId,
      }, { ip: "203.0.113.40" });
      await rateLimiter(req, res, next);
    }

    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-b",
      anonymousSessionId: sessionId,
    }, { ip: "203.0.113.40" });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });
});
