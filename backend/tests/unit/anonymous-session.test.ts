import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  ANONYMOUS_SESSION_HEADER,
  resolveAnonymousSession,
  shouldUseSecureAnonymousCookie,
  WEBSITE_EMBED_SESSION_HEADER,
} from "../../src/app/http/middleware/resolveAnonymousSession.js";
import { issueWebsiteEmbedSession } from "../../src/modules/settings/domain/websiteEmbedSession.js";
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
    const { req, res, next, getError } = createMockReqRes({ token: "test-token-1234567890" });

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
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBe("existing-session-id");
  });

  it("prefers the anonymous session header when present", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const sessionId = "67acb0c8-caad-4a1b-9fef-70cbca3f7d12";
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      { [`anon_session_${workspace.id}`]: "existing-session-id" },
      { [ANONYMOUS_SESSION_HEADER]: sessionId },
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBe(sessionId);
  });

  it("generates a new session id and sets cookie when none exists", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    let setCookieName = "";
    const { req, res, next } = createMockReqRes({ token: "test-token-1234567890" });
    (res as any).cookie = (name: string, _value: string, _options: unknown) => {
      setCookieName = name;
    };

    await middleware(req, res, next);

    expect(setCookieName).toBe(`anon_session_${workspace.id}`);
    expect(res.locals.anonymousSessionId).toBeDefined();
    expect(typeof res.locals.anonymousSessionId).toBe("string");
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

  it("sets a non-secure anonymous cookie for localhost-hosted public chat in production", async () => {
    process.env.NODE_ENV = "production";

    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    let cookieOptions: Record<string, unknown> | undefined;
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      { host: "localhost:3000" },
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
    const { req, res, next } = createMockReqRes({ token: "test-token-1234567890" });
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

  it("allows embedded chat sessions even when anonymous chat is disabled", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateGeneralSettings(workspace.id, {
      anonymousChatEnabled: false,
      anonymousChatToken: "test-token-1234567890",
      anonymousRateLimit: 10,
      assistantName: "",
      assistantRole: "",
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

    const embedSession = issueWebsiteEmbedSession(SESSION_SECRET, {
      workspaceId: workspace.id,
      publicChatToken: "test-token-1234567890",
      anonymousSessionId: "67acb0c8-caad-4a1b-9fef-70cbca3f7d12",
    });

    const middleware = resolveAnonymousSession(workspaceRepository, SESSION_SECRET);
    const { req, res, next, getError } = createMockReqRes(
      { token: "test-token-1234567890" },
      {},
      { [WEBSITE_EMBED_SESSION_HEADER]: embedSession.token },
    );

    await middleware(req, res, next);

    expect(getError()).toBeUndefined();
    expect(res.locals.workspaceId).toBe(workspace.id);
    expect(res.locals.anonymousSessionId).toBe("67acb0c8-caad-4a1b-9fef-70cbca3f7d12");
  });
});
