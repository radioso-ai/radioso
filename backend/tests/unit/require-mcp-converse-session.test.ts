import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { requireMcpConverseSession } from "../../src/app/http/middleware/requireMcpConverseSession.js";
import { AppError } from "../../src/shared/domain/errors.js";

const requestWithBearer = (token: string): Request => ({
  header: vi.fn((name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined),
} as unknown as Request);

describe("MCP converse credential-class separation", () => {
  it("delegates an opaque session token to the session service without classifying its shape", async () => {
    const principal = {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      publicSessionId: "conversation-1",
      grantId: "grant-1",
      grantVersion: "1",
      sourceChannel: "mcp" as const,
      sourceOrigin: null,
      authPrincipal: {
        type: "public_chat_session" as const,
        role: "public" as const,
        workspaceId: "workspace-1",
        agentId: "agent-1",
        publicSessionId: "conversation-1",
      },
    };
    const validate = vi.fn().mockResolvedValue(principal);
    const middleware = requireMcpConverseSession({ validate });
    const req = requestWithBearer("opaque-session-without-a-dot");
    const res = { locals: {} } as Response;
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(validate).toHaveBeenCalledWith("opaque-session-without-a-dot");
    expect(res.locals).toMatchObject({
      workspaceId: "workspace-1",
      mcpConversePrincipal: principal,
    });
    expect(next).toHaveBeenCalledWith();
  });

  it("returns the generic session error when validation rejects an API credential", async () => {
    const validate = vi.fn().mockRejectedValue(new AppError(
      401,
      "unauthorized",
      "MCP converse session is required.",
      { code: "invalid_session" },
    ));
    const middleware = requireMcpConverseSession({ validate });
    const next = vi.fn() as NextFunction;

    await middleware(requestWithBearer("radioso_pat_opaque"), { locals: {} } as Response, next);

    expect(validate).toHaveBeenCalledWith("radioso_pat_opaque");
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: "unauthorized",
      details: { code: "invalid_session" },
    }));
  });
});
