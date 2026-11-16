import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  publicChatTurnRateLimiter,
  publicChatEmbedConfigRateLimiter,
  publicChatFeedbackRateLimiter,
  publicChatSessionReadRateLimiter,
  resetRateLimiterState,
} from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { Env } from "../../src/app/config/env.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { createTestDependencies } from "../support/testApp.js";
import { InMemoryAbuseControlRepository } from "../support/fakes.js";

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

const middleware = () => publicChatTurnRateLimiter(createTestDependencies().dependencies);

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

  type TurnOutcome = { admitted: boolean; status: number };
  type RequestSourceLocal = { address: string | null; digest: string; identifiesClient: boolean };

  const turnLimiter = (env: Partial<Env>) =>
    publicChatTurnRateLimiter(createTestDependencies({ envOverrides: env }).dependencies);

  const sendTurn = async (
    limiter: RequestHandler,
    input: { workspaceId?: string; browserId?: string; ip?: string; requestSource?: RequestSourceLocal },
  ): Promise<TurnOutcome> => {
    const locals: Record<string, unknown> = {
      workspaceId: input.workspaceId ?? "workspace-1",
      anonymousSessionId: "session-1",
      anonymousRateLimitId: input.browserId ?? "minted-for-this-request",
      anonymousRateLimitIdFromCookie: input.browserId !== undefined,
      ...(input.requestSource ? { requestSource: input.requestSource } : {}),
    };
    const { req, res, next, wasNextCalled, getStatus } = createMockReqRes(locals, { ip: input.ip ?? "203.0.113.70" });
    await limiter(req, res, next);
    return wasNextCalled() ? { admitted: true, status: 200 } : { admitted: false, status: getStatus() };
  };

  it("runs out for a caller that presents a fresh rate-limit cookie on every message", async () => {
    const chain = turnLimiter({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 3 });

    for (let i = 0; i < 3; i++) {
      expect(await sendTurn(chain, { browserId: `rotated-${i}` })).toEqual({ admitted: true, status: 200 });
    }

    expect(await sendTurn(chain, { browserId: "rotated-3" })).toEqual({ admitted: false, status: 429 });
  });

  it("counts messages sent without a rate-limit cookie against the same source budget", async () => {
    const chain = turnLimiter({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 3 });

    expect((await sendTurn(chain, {})).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "browser-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, {})).admitted).toBe(true);

    expect(await sendTurn(chain, { browserId: "browser-b" })).toEqual({ admitted: false, status: 429 });
  });

  it("gives browsers behind one shared address their own budgets until the source budget runs out", async () => {
    const chain = turnLimiter({
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
    const chain = turnLimiter({
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
    const chain = turnLimiter({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 1 });

    expect((await sendTurn(chain, { workspaceId: "workspace-a", browserId: "browser-a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { workspaceId: "workspace-a", browserId: "browser-b" })).admitted).toBe(false);

    expect((await sendTurn(chain, { workspaceId: "workspace-b", browserId: "browser-c" })).admitted).toBe(true);
  });

  it("keys an IPv6 caller's source budget on its /64", async () => {
    const chain = turnLimiter({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 2 });

    expect((await sendTurn(chain, { browserId: "v6-a", ip: "2001:db8:1:2::a" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "v6-b", ip: "2001:db8:1:2:ffff::b" })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "v6-c", ip: "2001:db8:1:2::c" })).admitted).toBe(false);

    expect((await sendTurn(chain, { browserId: "v6-d", ip: "2001:db8:1:3::a" })).admitted).toBe(true);
  });

  it("keys the source budget on the request source the app resolved, not the socket peer", async () => {
    const chain = turnLimiter({ PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 1 });
    const behindProxy = (digest: string) => ({ ip: "10.0.0.2", requestSource: { address: null, digest, identifiesClient: true } });

    expect((await sendTurn(chain, { browserId: "relayed-a", ...behindProxy("visitor-a-digest") })).admitted).toBe(true);
    expect((await sendTurn(chain, { browserId: "relayed-b", ...behindProxy("visitor-b-digest") })).admitted).toBe(true);

    expect((await sendTurn(chain, { browserId: "relayed-c", ...behindProxy("visitor-a-digest") })).admitted).toBe(false);
  });
});

describe("public chat turn budgets for a visitor without the rate-limit cookie", () => {
  beforeEach(() => {
    resetRateLimiterState();
    vi.restoreAllMocks();
  });

  const turnLimiter = (env: Partial<Env>, repository = new InMemoryAbuseControlRepository()) =>
    publicChatTurnRateLimiter(createTestDependencies({ envOverrides: env, abuseControlRepository: repository }).dependencies);

  // The website embed runs in a cross-site frame, where the browser withholds the rate-limit
  // cookie; what every one of its requests does carry is the signed public session.
  const sendEmbedTurn = async (
    limiter: RequestHandler,
    input: { sessionId: string; ip?: string; requestSource?: { address: string | null; digest: string; identifiesClient: boolean } },
  ) => {
    const { req, res, next, wasNextCalled, getStatus, getHeader, getBody } = createMockReqRes({
      workspaceId: "workspace-1",
      chatSessionId: input.sessionId,
      anonymousSessionId: input.sessionId,
      anonymousRateLimitId: "minted-for-this-request",
      anonymousRateLimitIdFromCookie: false,
      ...(input.requestSource ? { requestSource: input.requestSource } : {}),
    }, { ip: input.ip ?? "203.0.113.90" });
    await limiter(req, res, next);
    return { admitted: wasNextCalled(), status: wasNextCalled() ? 200 : getStatus(), getHeader, body: getBody() };
  };

  it("keys the visitor's own budget on its signed public session", async () => {
    const limiter = turnLimiter({ PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 100 });

    expect((await sendEmbedTurn(limiter, { sessionId: "embed-a" })).admitted).toBe(true);
    expect((await sendEmbedTurn(limiter, { sessionId: "embed-a" })).admitted).toBe(true);

    expect(await sendEmbedTurn(limiter, { sessionId: "embed-a" })).toMatchObject({ admitted: false, status: 429 });
  });

  it("keeps two embed visitors behind one address independent of each other", async () => {
    const limiter = turnLimiter({ PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 100 });

    for (let i = 0; i < 3; i++) {
      await sendEmbedTurn(limiter, { sessionId: "classroom-a", ip: "198.51.100.30" });
    }

    expect((await sendEmbedTurn(limiter, { sessionId: "classroom-b", ip: "198.51.100.30" })).admitted).toBe(true);
    expect((await sendEmbedTurn(limiter, { sessionId: "classroom-b", ip: "198.51.100.30" })).admitted).toBe(true);
  });

  it("still bounds a script that starts a fresh session for every message by the source budget", async () => {
    const limiter = turnLimiter({ PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 5 });
    const outcomes: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push((await sendEmbedTurn(limiter, { sessionId: `rotated-${i}`, ip: "198.51.100.31" })).admitted);
    }

    expect(outcomes).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("lets one browser's cookie hold its budget across the sessions its tabs open", async () => {
    const limiter = turnLimiter({ PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2, PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 100 });
    const sendFromTab = async (sessionId: string) => {
      const { req, res, next, wasNextCalled } = createMockReqRes({
        workspaceId: "workspace-1",
        chatSessionId: sessionId,
        anonymousRateLimitId: "browser-with-tabs",
        anonymousRateLimitIdFromCookie: true,
      });
      await limiter(req, res, next);
      return wasNextCalled();
    };

    expect(await sendFromTab("tab-1")).toBe(true);
    expect(await sendFromTab("tab-2")).toBe(true);
    expect(await sendFromTab("tab-3")).toBe(false);
  });

  it("skips the source budget when the address the backend sees belongs to the relay, not the visitor", async () => {
    const limiter = turnLimiter({
      PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 2,
      PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 1,
      PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 4,
    });
    const relay = { address: "10.0.0.2", digest: "relay-digest", identifiesClient: false };

    expect((await sendEmbedTurn(limiter, { sessionId: "relayed-a", requestSource: relay })).admitted).toBe(true);
    expect((await sendEmbedTurn(limiter, { sessionId: "relayed-b", requestSource: relay })).admitted).toBe(true);
    expect((await sendEmbedTurn(limiter, { sessionId: "relayed-c", requestSource: relay })).admitted).toBe(true);
    expect((await sendEmbedTurn(limiter, { sessionId: "relayed-d", requestSource: relay })).admitted).toBe(true);

    // The workspace budget still holds.
    expect(await sendEmbedTurn(limiter, { sessionId: "relayed-e", requestSource: relay })).toMatchObject({ admitted: false, status: 429 });
  });

  it("spends neither the visitor's nor the source's budget on a message the workspace budget refuses", async () => {
    const repository = new InMemoryAbuseControlRepository();
    const limiter = turnLimiter({ PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 1 }, repository);
    const source = { address: "203.0.113.91", digest: "source-b", identifiesClient: true };
    await sendEmbedTurn(limiter, { sessionId: "visitor-a", requestSource: { ...source, digest: "source-a" } });

    expect(await sendEmbedTurn(limiter, { sessionId: "visitor-b", requestSource: source })).toMatchObject({ admitted: false, status: 429 });

    expect(await repository.find("public.chat.session", "workspace-1:session:visitor-b")).toBeNull();
    expect(await repository.find("public.chat.source", "workspace-1:source:source-b")).toBeNull();
  });

  it("tells the visitor about its own budgets and never the workspace's", async () => {
    const limiter = turnLimiter({
      PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 10,
      PUBLIC_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 120,
      PUBLIC_CHAT_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS: 2,
    });

    const admitted = await sendEmbedTurn(limiter, { sessionId: "visitor-a" });
    expect(admitted.admitted).toBe(true);
    expect(admitted.getHeader("RateLimit-Limit")).toBe("10");
    expect(admitted.getHeader("RateLimit-Remaining")).toBe("9");
    await sendEmbedTurn(limiter, { sessionId: "visitor-b" });

    const refused = await sendEmbedTurn(limiter, { sessionId: "visitor-c" });
    expect(refused).toMatchObject({ admitted: false, status: 429 });
    expect(Number(refused.getHeader("Retry-After"))).toBeGreaterThan(0);
    expect(refused.getHeader("RateLimit-Limit")).toBeUndefined();
    expect(refused.getHeader("RateLimit-Remaining")).toBeUndefined();
    expect(refused.body).toEqual({ code: "rate_limit_exceeded", retryAfterSeconds: expect.any(Number) });
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

  it("keys a reader without the rate-limit cookie on its signed public session", async () => {
    const rateLimiter = publicChatSessionReadRateLimiter(
      createTestDependencies({ envOverrides: { PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS: 2 } }).dependencies,
    );
    const read = async (sessionId: string) => {
      const { req, res, next, wasNextCalled } = createMockReqRes(
        { workspaceId: "workspace-read", chatSessionId: sessionId, anonymousRateLimitIdFromCookie: false },
        { ip: "203.0.113.61" },
      );
      await rateLimiter(req, res, next);
      return wasNextCalled();
    };

    expect(await read("embed-reader-a")).toBe(true);
    expect(await read("embed-reader-a")).toBe(true);
    expect(await read("embed-reader-a")).toBe(false);

    expect(await read("embed-reader-b")).toBe(true);
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
