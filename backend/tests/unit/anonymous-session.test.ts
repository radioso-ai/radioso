import { describe, it, expect, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { resolveAnonymousSession } from "../../src/app/http/middleware/resolveAnonymousSession.js";
import { InMemoryWorkspaceRepository } from "../support/fakes.js";

const createMockReqRes = (params: Record<string, string> = {}, cookies: Record<string, string> = {}) => {
  const req = { params, cookies } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    cookie: (_name: string, _value: string, _options: unknown) => {},
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
  });

  it("returns 404 when token is missing", async () => {
    const middleware = resolveAnonymousSession(workspaceRepository);
    const { req, res, next, getError } = createMockReqRes({});

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("returns 404 when token does not match any workspace", async () => {
    const middleware = resolveAnonymousSession(workspaceRepository);
    const { req, res, next, getError } = createMockReqRes({ token: "nonexistent" });

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("returns 404 when anonymous chat is disabled", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, false, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository);
    const { req, res, next, getError } = createMockReqRes({ token: "test-token-1234567890" });

    await middleware(req, res, next);

    expect(getError()).toBeDefined();
    expect((getError() as any).statusCode).toBe(404);
  });

  it("sets workspaceId, anonymousSessionId, and anonymousRateLimit when valid", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 15);

    const middleware = resolveAnonymousSession(workspaceRepository);
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

    const middleware = resolveAnonymousSession(workspaceRepository);
    const { req, res, next } = createMockReqRes(
      { token: "test-token-1234567890" },
      { [`anon_session_${workspace.id}`]: "existing-session-id" },
    );

    await middleware(req, res, next);

    expect(res.locals.anonymousSessionId).toBe("existing-session-id");
  });

  it("generates a new session id and sets cookie when none exists", async () => {
    const workspace = await workspaceRepository.create("account-1", "Test");
    await workspaceRepository.updateAnonymousChatSettings(workspace.id, true, "test-token-1234567890", 10);

    const middleware = resolveAnonymousSession(workspaceRepository);
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
});
