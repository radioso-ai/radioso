import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { requirePublicChatPermission, requireWorkspacePermission } from "../../src/app/http/middleware/requirePermission.js";
import type { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";

const createRequestResponse = (locals: Record<string, unknown>) => {
  const req = {} as Request;
  const res = { locals } as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
};

describe("requireWorkspacePermission", () => {
  it("evaluates bearer-authenticated workspace API tokens through the access service", async () => {
    const requirePermission = vi.fn().mockResolvedValue(undefined);
    const middleware = requireWorkspacePermission(
      {
        accountAccessService: {
          requirePermission,
        } as unknown as AccountAccessService,
      },
      "workspace.settings.manage",
    );
    const { req, res, next } = createRequestResponse({
      accountId: "account-1",
      workspaceId: "workspace-1",
      authMode: "bearer",
      authPrincipal: {
        type: "workspace_api_token",
        role: "admin",
      },
    });

    await middleware(req, res, next);

    expect(requirePermission).toHaveBeenCalledWith({
      accountId: "account-1",
      permission: "workspace.settings.manage",
      workspaceId: "workspace-1",
      principal: {
        type: "workspace_api_token",
        role: "admin",
      },
    });
    expect(next).toHaveBeenCalledWith();
  });
});

describe("requirePublicChatPermission", () => {
  it("delegates public chat authorization to the access service", async () => {
    const requirePermission = vi.fn().mockResolvedValue(undefined);
    const middleware = requirePublicChatPermission(
      {
        accountAccessService: {
          requirePermission,
        } as unknown as AccountAccessService,
      },
      "public_chat.turn.create",
    );
    const principal = {
      type: "public_chat_session" as const,
      role: "public_chat" as const,
      workspaceId: "workspace-1",
      agentId: "agent-1",
      publicSessionId: "session-1",
    };
    const { req, res, next } = createRequestResponse({
      workspaceId: "workspace-1",
      authPrincipal: principal,
    });

    await middleware(req, res, next);

    expect(requirePermission).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      principal,
      permission: "public_chat.turn.create",
    });
    expect(next).toHaveBeenCalledWith();
  });
});
