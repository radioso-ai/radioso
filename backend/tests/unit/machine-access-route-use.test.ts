import type { NextFunction, Request, Response } from "express";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { markHttpResponseFailed } from "../../src/app/http/middleware/httpResponseCompletion.js";
import { requireApiToken } from "../../src/app/http/middleware/requireApiToken.js";
import { requireWorkspaceSession } from "../../src/app/http/middleware/requireWorkspaceSession.js";

const principal = {
  type: "personal_api_credential" as const,
  userId: "user-1",
  credentialId: "credential-1",
  role: "member" as const,
  workspaceId: "workspace-1",
};

class TestResponse extends EventEmitter {
  locals: Record<string, unknown> = {};
  statusCode = 200;
}

const runWorkspaceMiddleware = async (baseUrl: string, path: string) => {
  const recordApiTokenUse = vi.fn();
  const dependencies = {
    env: { SESSION_COOKIE_NAME: "session" },
    authService: {
      authenticateSession: vi.fn(),
      authenticateApiToken: vi.fn().mockResolvedValue({ accountId: "account-1", workspaceId: "workspace-1", principal }),
      recordApiTokenUse,
    },
    accountAccessService: { requireActiveMembership: vi.fn() },
    workspaceSessionService: { resolve: vi.fn() },
    machineAccessSecurityObserver: { recordAuthorizationDenial: vi.fn() },
  };
  const req = {
    baseUrl,
    path,
    method: "GET",
    cookies: {},
    header: vi.fn((name: string) => name.toLowerCase() === "authorization" ? "Bearer machine-secret" : undefined),
  } as unknown as Request;
  const res = new TestResponse() as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  await requireWorkspaceSession(dependencies as never)(req, res, next);
  return { dependencies, next, recordApiTokenUse, res };
};

const runRequiredMachineMiddleware = async () => {
  const recordApiTokenUse = vi.fn();
  const dependencies = {
    authService: {
      authenticateApiToken: vi.fn().mockResolvedValue({ accountId: "account-1", workspaceId: "workspace-1", principal }),
      recordApiTokenUse,
    },
  };
  const req = {
    baseUrl: "/api/v1/skills",
    path: "/example",
    method: "GET",
    header: vi.fn((name: string) => name.toLowerCase() === "authorization" ? "Bearer machine-secret" : undefined),
  } as unknown as Request;
  const res = new TestResponse() as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;

  await requireApiToken(dependencies)(req, res, next);
  return { next, recordApiTokenUse, res };
};

describe("machine API credential route success usage", () => {
  it("does not record last use when the route policy rejects the credential", async () => {
    const result = await runWorkspaceMiddleware("/api/v1/account", "/users");

    expect(result.dependencies.authService.authenticateApiToken).toHaveBeenCalledOnce();
    expect(result.recordApiTokenUse).not.toHaveBeenCalled();
    expect(result.next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it("records last use only after an accepted route finishes successfully", async () => {
    const result = await runWorkspaceMiddleware("/api/v1/skills", "/example");

    expect(result.next).toHaveBeenCalledWith();
    expect(result.recordApiTokenUse).not.toHaveBeenCalled();

    result.res.emit("finish");

    expect(result.recordApiTokenUse).toHaveBeenCalledWith(principal);
  });

  it.each([400, 429, 500])("does not record last use when the route finishes with %i", async (statusCode) => {
    const result = await runWorkspaceMiddleware("/api/v1/skills", "/example");
    result.res.statusCode = statusCode;

    result.res.emit("finish");

    expect(result.recordApiTokenUse).not.toHaveBeenCalled();
  });

  it("does not record last use when the response closes before finishing", async () => {
    const result = await runWorkspaceMiddleware("/api/v1/skills", "/example");

    result.res.emit("close");

    expect(result.recordApiTokenUse).not.toHaveBeenCalled();
  });

  it("does not record a failed stream even when its 200 response is ended", async () => {
    const result = await runWorkspaceMiddleware("/api/v1/skills", "/example");

    markHttpResponseFailed(result.res);
    result.res.emit("finish");

    expect(result.recordApiTokenUse).not.toHaveBeenCalled();
  });

  it("uses the same completion boundary for machine-only routes and accepts 204", async () => {
    const result = await runRequiredMachineMiddleware();
    result.res.statusCode = 204;

    expect(result.recordApiTokenUse).not.toHaveBeenCalled();
    result.res.emit("finish");

    expect(result.recordApiTokenUse).toHaveBeenCalledWith(principal);
  });
});
