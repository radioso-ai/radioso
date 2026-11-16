import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  anonymousRateLimiters,
  publicChatEmbedConfigRateLimiter,
  publicChatFeedbackRateLimiter,
  publicChatSessionReadRateLimiter,
  resetRateLimiterState,
} from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { Env } from "../../src/app/config/env.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { createTestDependencies } from "../support/testApp.js";

const createMockReqRes = (
  locals: Record<string, unknown> = {},
  options: { ip?: string; forwardedFor?: string; params?: Record<string, string> } = {},
) => {
  const req = {
    ip: options.ip ?? "203.0.113.10",
    socket: { remoteAddress: options.ip ?? "203.0.113.10" },
    params: options.params ?? {},
    get(name: string) {
      return name.toLowerCase() === "x-forwarded-for" ? options.forwardedFor : undefined;
    },
  } as unknown as Request;
  let responseBody: unknown = undefined;
  let responseStatus = 200;
  let nextError: unknown = undefined;
  const headers = new Map<string, string>();
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
    setHeader(name: string, value: string | number) {
      headers.set(name, String(value));
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
    getHeader: (name: string) => headers.get(name),
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
    const { req, res, next, getStatus, getBody, getHeader, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: sessionId,
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
    expect((getBody() as any).code).toBe("rate_limit_exceeded");
    expect((getBody() as any).retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(getHeader("Retry-After"))).toBeGreaterThan(0);
    expect(getHeader("RateLimit-Remaining")).toBe("0");
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

describe("public chat turn budgets for one request source", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  type ChainOutcome = { admitted: boolean; status: number };

  const turnLimiters = (env: Partial<Env>) => anonymousRateLimiters(createTestDependencies({ envOverrides: env }).dependencies);

  // Runs the whole turn-creation chain the way Express would: stop at the first refusal.
  const sendTurn = async (
    chain: ReturnType<typeof anonymousRateLimiters>,
    input: { workspaceId?: string; browserId?: string; ip?: string; requestSource?: { address: string | null; digest: string } },
  ): Promise<ChainOutcome> => {
    const locals: Record<string, unknown> = {
      workspaceId: input.workspaceId ?? "workspace-1",
      anonymousSessionId: "session-1",
      anonymousRateLimitId: input.browserId ?? "minted-for-this-request",
      anonymousRateLimitIdFromCookie: input.browserId !== undefined,
      ...(input.requestSource ? { requestSource: input.requestSource } : {}),
    };
    for (const middleware of chain) {
      const { req, res, next, wasNextCalled, getStatus } = createMockReqRes(locals, { ip: input.ip ?? "203.0.113.70" });
      await middleware(req, res, next);
      if (!wasNextCalled()) {
        return { admitted: false, status: getStatus() };
      }
    }
    return { admitted: true, status: 200 };
  };

  it("runs out for a caller that presents a fresh rate-limit cookie on every message", async () => {
    const chain = turnLimiters({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 3 });

    for (let i = 0; i < 3; i++) {
      expect(await sendTurn(chain, { browserId: `rotated-${i}` })).toEqual({ admitted: true, status: 200 });
    }

    expect(await sendTurn(chain, { browserId: "rotated-3" })).toEqual({ admitted: false, status: 429 });
  });

  it("counts messages sent without a rate-limit cookie against the same source budget", async () => {
    const chain = turnLimiters({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 3 });

    expect((await sendTurn(chain, {})).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "browser-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, {})).admitted).toBe(true);

    expect(await sendTurn(chain, { browserId: "browser-b" })).toEqual({ admitted: false, status: 429 });
  });

  it("gives browsers behind one shared address their own budgets until the source budget runs out", async () => {
    const chain = turnLimiters({
      PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2,
      PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 5,
    });

    expect((await sendTurn(chain, { browserId: "classroom-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "classroom-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "classroom-a" })).admitted).toBe(false);
    expect((await sendTurn(chain, { browserId: "classroom-b" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "classroom-b" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "classroom-c" })).admitted).toBe(true);

    expect((await sendTurn(chain, { browserId: "classroom-d" })).admitted).toBe(false);
  });

  it("leaves the workspace budget to other visitors once one source is refused", async () => {
    const chain = turnLimiters({
      PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 2,
      PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 4,
    });

    for (let i = 0; i < 12; i++) {
      await sendTurn(chain, { browserId: `script-${i}`, ip: "198.51.100.7" });
    }

    expect((await sendTurn(chain, { browserId: "visitor-a", ip: "203.0.113.81" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "visitor-b", ip: "203.0.113.82" })).admitted).toBe(true);
    expect(await sendTurn(chain, { browserId: "visitor-c", ip: "203.0.113.83" })).toEqual({ admitted: false, status: 429 });
  });

  it("keeps the source budget per workspace", async () => {
    const chain = turnLimiters({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 1 });

    expect((await sendTurn(chain, { workspaceId: "workspace-a", browserId: "browser-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { workspaceId: "workspace-a", browserId: "browser-b" })).admitted).toBe(false);

    expect((await sendTurn(chain, { workspaceId: "workspace-b", browserId: "browser-c" })).admitted).toBe(true);
  });

  it("keys an IPv6 caller's source budget on its /64", async () => {
    const chain = turnLimiters({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 2 });

    expect((await sendTurn(chain, { browserId: "v6-a", ip: "2001:db8:1:2::a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "v6-b", ip: "2001:db8:1:2:ffff::b" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "v6-c", ip: "2001:db8:1:2::c" })).admitted).toBe(false);

    expect((await sendTurn(chain, { browserId: "v6-d", ip: "2001:db8:1:3::a" })).admitted).toBe(true);
  });

  it("keys the source budget on the request source the app resolved, not the socket peer", async () => {
    const chain = turnLimiters({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 1 });
    const behindProxy = (digest: string) => ({ ip: "10.0.0.2", requestSource: { address: null, digest } });

    expect((await sendTurn(chain, { browserId: "relayed-a", ...behindProxy("visitor-a-digest") })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "relayed-b", ...behindProxy("visitor-b-digest") })).admitted).toBe(true);

    expect((await sendTurn(chain, { browserId: "relayed-c", ...behindProxy("visitor-a-digest") })).admitted).toBe(false);
  });
});

describe("publicChatEmbedConfigRateLimiter", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  const middleware = () => publicChatEmbedConfigRateLimiter(createTestDependencies().dependencies);

  it("allows requests under the limit", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({}, { params: { token: "launch-token-1" } });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("rejects at the limit with 429, scoped by launch token", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({}, { params: { token: "launch-token-2" } });
      await rateLimiter(req, res, next);
    }

    const { req, res, next, getStatus, wasNextCalled } = createMockReqRes({}, { params: { token: "launch-token-2" } });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
  });

  it("passes through when no launch token is present", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({}, { params: {} });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });
});

describe("publicChatSessionReadRateLimiter", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  const middleware = () => publicChatSessionReadRateLimiter(createTestDependencies().dependencies);

  it("allows requests under the limit", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({ workspaceId: "workspace-1" });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("rejects at the limit with 429, scoped by workspace and request source", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes(
        { workspaceId: "workspace-read" },
        { ip: "203.0.113.60" },
      );
      await rateLimiter(req, res, next);
    }

    const { req, res, next, getStatus, wasNextCalled } = createMockReqRes(
      { workspaceId: "workspace-read" },
      { ip: "203.0.113.60" },
    );
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
  });

  it("passes through when no workspaceId is set", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({});

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });
});

describe("publicChatFeedbackRateLimiter", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  const middleware = () => publicChatFeedbackRateLimiter(createTestDependencies().dependencies);

  it("allows requests under the limit", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-1",
      anonymousSessionId: "session-1",
    });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });

  it("rejects at the limit with 429, scoped by workspace and session", async () => {
    const rateLimiter = middleware();
    const limit = createTestDependencies().dependencies.env.PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS;

    for (let i = 0; i < limit; i++) {
      const { req, res, next } = createMockReqRes({
        workspaceId: "workspace-feedback",
        anonymousSessionId: "session-feedback",
      });
      await rateLimiter(req, res, next);
    }

    const { req, res, next, getStatus, wasNextCalled } = createMockReqRes({
      workspaceId: "workspace-feedback",
      anonymousSessionId: "session-feedback",
    });
    await rateLimiter(req, res, next);

    expect(wasNextCalled()).toBe(false);
    expect(getStatus()).toBe(429);
  });

  it("passes through when workspaceId or anonymousSessionId is missing", async () => {
    const { req, res, next, wasNextCalled } = createMockReqRes({ workspaceId: "workspace-1" });

    await middleware()(req, res, next);

    expect(wasNextCalled()).toBe(true);
  });
});
