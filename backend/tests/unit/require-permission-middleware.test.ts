import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  holdsWorkspacePermission,
  requirePublicChatPermission,
  requireWorkspacePermission,
} from "../../src/app/http/middleware/requirePermission.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import {
  createAuditService,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceGrantRepository,
} from "../support/fakes.js";

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
        },
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
        workspaceId: "workspace-1",
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
        workspaceId: "workspace-1",
      },
    });
    expect(next).toHaveBeenCalledWith();
  });

  it("passes a path workspace to scope-aware authorization without replacing the token scope", async () => {
    const requirePermission = vi.fn().mockResolvedValue(undefined);
    const middleware = requireWorkspacePermission(
      {
        accountAccessService: {
          requirePermission,
        },
      },
      "workspace.documents.manage",
      () => "workspace-b",
    );
    const principal = {
      type: "workspace_api_token" as const,
      role: "admin" as const,
      workspaceId: "workspace-a",
    };
    const { req, res, next } = createRequestResponse({
      accountId: "account-1",
      workspaceId: "workspace-a",
      authPrincipal: principal,
    });

    await middleware(req, res, next);

    expect(requirePermission).toHaveBeenCalledWith({
      accountId: "account-1",
      permission: "workspace.documents.manage",
      principal,
      workspaceId: "workspace-b",
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
        },
      },
      "public_chat.turn.create",
    );
    const principal = {
      type: "public_chat_session" as const,
      role: "public" as const,
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

describe("holdsWorkspacePermission", () => {
  const createAccess = async () => {
    const users = new InMemoryUserRepository();
    const memberships = new InMemoryAccountMembershipRepository();
    memberships.setUserRepository(users);
    const grants = new InMemoryWorkspaceGrantRepository();
    const accountAccessService = new AccountAccessService(memberships, createAuditService(), grants);
    const addMember = async (email: string) => {
      const user = await users.create({ email, passwordHash: "hash" });
      await memberships.create({ accountId: "account-1", userId: user.id, role: "member" });
      return user.id;
    };
    const member = await addMember("member@example.com");
    const grantedAdmin = await addMember("granted@example.com");
    await grants.upsert({ workspaceId: "workspace-1", accountId: "account-1", userId: grantedAdmin, role: "admin" });
    return { accountAccessService, memberships, member, grantedAdmin };
  };

  // A teammate's request through the route's own permission check, then the permission that shapes
  // what the route returns.
  const holdsAfterCheck = async (
    accountAccessService: AccountAccessService,
    userId: string,
    permission: "workspace.quality.read",
  ) => {
    const { req, res, next } = createRequestResponse({ accountId: "account-1", userId, workspaceId: "workspace-1" });
    await requireWorkspacePermission({ accountAccessService }, "workspace.history.read")(req, res, next);
    expect(next).toHaveBeenCalledWith();
    return holdsWorkspacePermission({ accountAccessService }, res, permission);
  };

  it("answers from the role the route's permission check resolved, with no second membership lookup", async () => {
    const { accountAccessService, memberships, member, grantedAdmin } = await createAccess();
    const lookups = vi.spyOn(memberships, "findActiveByAccountAndUser");
    const hasPermission = vi.spyOn(accountAccessService, "hasPermission");

    await expect(holdsAfterCheck(accountAccessService, member, "workspace.quality.read")).resolves.toBe(false);
    await expect(holdsAfterCheck(accountAccessService, grantedAdmin, "workspace.quality.read")).resolves.toBe(true);

    expect(lookups).toHaveBeenCalledTimes(2);
    expect(hasPermission).not.toHaveBeenCalled();
  });

  it("asks the access service when no check resolved a role on the request's workspace", async () => {
    const { accountAccessService, grantedAdmin } = await createAccess();
    const hasPermission = vi.spyOn(accountAccessService, "hasPermission");
    const unchecked = createRequestResponse({ accountId: "account-1", userId: grantedAdmin, workspaceId: "workspace-1" });
    const elsewhere = createRequestResponse({
      accountId: "account-1",
      userId: grantedAdmin,
      workspaceId: "workspace-1",
      checkedWorkspaceRole: { workspaceId: "workspace-2", role: "owner" },
    });

    await expect(holdsWorkspacePermission({ accountAccessService }, unchecked.res, "workspace.quality.read")).resolves.toBe(true);
    await expect(holdsWorkspacePermission({ accountAccessService }, elsewhere.res, "account.organization.delete")).resolves.toBe(false);
    expect(hasPermission).toHaveBeenCalledTimes(2);
  });
});
