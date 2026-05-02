import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  ANONYMOUS_SESSION_HEADER,
  PUBLIC_CHAT_SESSION_HEADER,
  resolveAnonymousSession,
  shouldUseSecureAnonymousCookie,
} from "../../src/app/http/middleware/resolveAnonymousSession.js";
import { issuePublicChatSession } from "../../src/modules/settings/domain/publicChatSession.js";
import { InMemoryWorkspaceRepository } from "../support/fakes.js";

const originalNodeEnv = process.env.NODE_ENV;
const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const createMockReqRes = (
  params: Record<string, string> = {},
  cookies: Record<string, string> = {},
  headers: Record<string, string> = {},
) => {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const req = {
    params,
    cookies,
    get(name: string) {
      return normalizedHeaders[name.toLowerCase()];
    },
  } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    cookie: (_name: string, _value: string, _options: unknown) => {},
    setHeader: (_name: string, _value: string) => {},
  } as unknown as Response;
  let nextError: unknown = undefined;
  const next: NextFunction = (err?: unknown) => {
    nextError = err;
  };
  return { req, res, next, getError: () => nextError };
};

describe("resolveAnonymousSession", () => {
  let workspaceRepository: InMemoryWorkspaceRepository;

  const issueSessionHeader = (
    workspaceId: string,
    publicSessionId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
    sourceChannel: "anonymous" | "website_embed" = "anonymous",
  ) => {
    const session = issuePublicChatSession(SESSION_SECRET, {
      workspaceId,
      publicChatToken: "test-token-1234567890",
      publicSessionId,
      sourceChannel,
      sourceOrigin: sourceChannel === "website_embed" ? "https://example.com" : null,
    });
    return { [PUBLIC_CHAT_SESSION_HEADER]: session.token };
  };

  beforeEach(() => {
    workspaceRepository = new InMemoryWorkspaceRepository();
    process.env.NODE_ENV = originalNodeEnv;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns 404 when token is missing", async () => {
    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes({});

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("returns 404 when token does not match any workspace", async () => {
    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes({ token: "nonexistent" });

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("returns 404 when anonymous chat is disabled", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, false, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes({ token: "test-token-1234567890" });

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("sets workspaceId, anonymousSessionId, and anonymousRateLimit when valid", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 15);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      issueSessionHeader(workspace.id),
    );

    await middleware(req, res, next);

    expect(getError()).toBeUndefined();
    expect(res.locals.workspaceId).toBe(workspace.id);
    expect(res.locals.anonymousSessionId).toBeDefined();
    expect(res.locals.anonymousRateLimit).toBe(15);
  });

  it("reuses existing cookie session id", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      { [`anon_session_${workspace.id}`]: "existing-session-id" },
      issueSessionHeader(workspace.id, "67acb0c8-caad-4a1b-9fef-70cbca3f7d12"),
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBe("67acb0c8-caad-4a1b-9fef-70cbca3f7d12");
  });

  it("uses the signed public session instead of caller-supplied anonymous session headers", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const sessionId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12";
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      { [`anon_session_${workspace.id}`]: "existing-session-id" },
      {
        [ANONYMOUS_SESSION_HEADER]: sessionId,
        ...issueSessionHeader(workspace.id, "4fb60e22-8373-44a0-8059-2b587a82a205"),
      },
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBe("4fb60e22-8373-44a0-8059-2b587a82a205");
  });

  it("uses a new anonymous session when the caller presents a new signed public session", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      { [`anon_session_${workspace.id}`]: "existing-session-id" },
      issueSessionHeader(workspace.id, "4fb60e22-8373-44a0-8059-2b587a82a205"),
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBeDefined();
    expect(res.locals.anonymousSessionId).toBe("4fb60e22-8373-44a0-8059-2b587a82a205");
  });

  it("generates a new session id and sets cookie when none exists", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const setCookieNames: string[] = [];
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      issueSessionHeader(workspace.id),
    );
    (res as any).cookie = (name: string, _value: string, _options: unknown) => {
      setCookieNames.push(name);
    };

    await middleware(req, res, next);

    expect(setCookieNames).toContain(`anon_session_${workspace.id}`);
    expect(res.locals.anonymousSessionId).toBeDefined();
    expect(typeof res.locals.anonymousSessionId).toBe("string");
  });

  it("sets a signed anonymous rate-limit cookie separately from the resettable session cookie", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const cookies = new Map<string, string>();
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      issueSessionHeader(workspace.id),
    );
    (res as any).cookie = (name: string, value: string, _options: unknown) => {
      cookies.set(name, value);
    };

    await middleware(req, res, next);

    expect(cookies.has(`anon_session_${workspace.id}`)).toBe(true);
    expect(cookies.get(`anon_rate_limit_${workspace.id}`)).toMatch(/^[^.]+\.[^.]+$/);
    expect(res.locals.anonymousRateLimitId).toBeDefined();
    expect(res.locals.anonymousRateLimitIdFromCookie).toBe(false);
  });

  it("reuses a valid anonymous rate-limit cookie when the chat session is reset", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const cookies = new Map<string, string>();
    const first = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      issueSessionHeader(workspace.id),
    );
    (first.res as any).cookie = (name: string, value: string, _options: unknown) => {
      cookies.set(name, value);
    };

    await middleware(first.req, first.res, first.next);

    const originalRateLimitId = first.res.locals.anonymousRateLimitId;
    const reset = createMockReqRes(
      { token: "test-token-1234567890" },
      {
        [`anon_session_${workspace.id}`]: "existing-session-id",
        [`anon_rate_limit_${workspace.id}`]: cookies.get(`anon_rate_limit_${workspace.id}`)!,
      },
      issueSessionHeader(workspace.id, "4fb60e22-8373-44a0-8059-2b587a82a205"),
    );

    await middleware(reset.req, reset.res, reset.next);

    expect(reset.res.locals.anonymousSessionId).toBe("4fb60e22-8373-44a0-8059-2b587a82a205");
    expect(reset.res.locals.anonymousRateLimitId).toBe(originalRateLimitId);
    expect(reset.res.locals.anonymousRateLimitIdFromCookie).toBe(true);
  });

  it("does not mark anonymous cookies as secure for localhost hosts in production", async () => {
    process.env.NODE_ENV = "production";

    const { req } = createMockReqRes({}, {}, { host: "localhost:3000" });

    expect(shouldUseSecureAnonymousCookie(req)).toBe(false);
  });

  it("marks anonymous cookies as secure for non-local hosts in production", async () => {
    process.env.NODE_ENV = "production";

    const { req } = createMockReqRes({}, {}, { host: "app.example.com" });

    expect(shouldUseSecureAnonymousCookie(req)).toBe(true);
  });

  it("prefers forwarded host over internal loopback host in production", async () => {
    process.env.NODE_ENV = "production";

    const { req } = createMockReqRes({}, {}, {
      host: "localhost:3000",
      "x-forwarded-host": "app.example.com",
    });

    expect(shouldUseSecureAnonymousCookie(req)).toBe(true);
  });

  it("sets a non-secure anonymous cookie for localhost-hosted public chat in production", async () => {
    process.env.NODE_ENV = "production";

    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    let cookieOptions: Record<string, unknown> | undefined;
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      { host: "localhost:3000", ...issueSessionHeader(workspace.id) },
    );
    (res as unknown as { cookie: (name: string, value: string, options: Record<string, unknown>) => void }).cookie =
      (_name, _value, options) => {
        cookieOptions = options;
      };

    await middleware(req, res, next);

    expect(cookieOptions?.secure).toBe(false);
  });

  it("exposes the resolved anonymous session id in a response header", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    let sessionHeaderValue = "";
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      issueSessionHeader(workspace.id),
    );
    (res as unknown as { setHeader: (name: string, value: string) => void }).setHeader = (name, value) => {
      if (name.toLowerCase() === ANONYMOUS_SESSION_HEADER) {
        sessionHeaderValue = value;
      }
    };

    await middleware(req, res, next);

    expect(sessionHeaderValue).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("accepts a valid website embed public session when anonymous chat is disabled", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: false,
      anonymousChatToken: "test-token-1234567890",
      anonymousRateLimit: 10,
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      websiteEmbedEnabled: true,
      websiteEmbedToken: "embed-token-123",
      websiteEmbedAllowedOrigins: ["https://example.com"],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
    });

    const embedSession = issuePublicChatSession(SESSION_SECRET, {
      workspaceId: workspace.id,
      publicChatToken: "test-token-1234567890",
      publicSessionId: "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
      sourceChannel: "website_embed",
      sourceOrigin: "https://example.com",
    });

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      {
        [PUBLIC_CHAT_SESSION_HEADER]: embedSession.token,
      },
    );

    await middleware(req, res, next);

    expect(getError()).toBeUndefined();
    expect(res.locals.anonymousSessionId).toBe("67acb0c8-caad-4a1b-9fef-70cbca3f7d12");
    expect(res.locals.sourceChannel).toBe("website_embed");
    expect(res.locals.sourceOrigin).toBe("https://example.com");
  });

  it("rejects an invalid public session when anonymous chat is disabled", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: false,
      anonymousChatToken: "test-token-1234567890",
      anonymousRateLimit: 10,
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      websiteEmbedEnabled: true,
      websiteEmbedToken: "embed-token-123",
      websiteEmbedAllowedOrigins: ["https://example.com"],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
    });

    const embedSession = issuePublicChatSession(SESSION_SECRET, {
      workspaceId: workspace.id,
      publicChatToken: "test-token-1234567890",
      publicSessionId: "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
      sourceChannel: "website_embed",
      sourceOrigin: "https://example.com",
    });

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      {
        [PUBLIC_CHAT_SESSION_HEADER]: `${embedSession.token}tampered`,
      },
    );

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });
});
