import type { Request, RequestHandler, Response } from "express";

import type {
  AccountPermission,
  AuthenticatedPrincipal,
  PublicChatPermission,
} from "../../../modules/account/services/accountAccessService.js";

interface PermissionDependencies {
  accountAccessService: {
    requirePermission(input: {
      accountId?: string | null;
      userId?: string | null;
      principal?: AuthenticatedPrincipal | null;
      permission: AccountPermission | PublicChatPermission;
      workspaceId?: string | null;
    }): Promise<void>;
  };
}

type WorkspacePermissionDependencies = PermissionDependencies;

interface PermissionCheckDependencies {
  accountAccessService: {
    hasPermission(input: {
      accountId?: string;
      userId?: string | null;
      principal?: AuthenticatedPrincipal | null;
      permission: AccountPermission;
      workspaceId?: string | null;
    }): Promise<boolean>;
  };
}

/**
 * Whether the caller holds `permission` on the request's workspace, for a route that shapes what it
 * returns by a permission rather than refusing without it. Runs after the route's own permission
 * middleware, which has already placed the workspace in the caller's account.
 */
export const holdsWorkspacePermission = (
  dependencies: PermissionCheckDependencies,
  res: Response,
  permission: AccountPermission,
): Promise<boolean> => {
  const { accountId, userId, workspaceId, authPrincipal } = res.locals as {
    accountId: string;
    userId?: string;
    workspaceId?: string;
    authPrincipal?: AuthenticatedPrincipal;
  };
  return dependencies.accountAccessService.hasPermission({
    accountId,
    userId,
    principal: authPrincipal,
    permission,
    workspaceId,
  });
};

export const requireAccountPermission = (
  dependencies: WorkspacePermissionDependencies,
  permission: AccountPermission,
): RequestHandler => async (_req, res, next) => {
  try {
    const { accountId, userId, authPrincipal } = res.locals as {
      accountId: string;
      userId?: string;
      authPrincipal?: AuthenticatedPrincipal;
    };
    await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      principal: authPrincipal,
      permission,
    });
    next();
  } catch (error) {
    next(error);
  }
};

export const requireWorkspacePermission = (
  dependencies: WorkspacePermissionDependencies,
  permission: AccountPermission,
  resolveWorkspaceId?: (req: Request, res: Response) => string | null | undefined,
): RequestHandler => async (req, res, next) => {
  try {
    const { accountId, userId, workspaceId, authPrincipal } = res.locals as {
      accountId: string;
      userId?: string;
      workspaceId?: string;
      authPrincipal?: AuthenticatedPrincipal;
    };
    await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      principal: authPrincipal,
      permission,
      workspaceId: resolveWorkspaceId?.(req, res) ?? workspaceId,
    });
    next();
  } catch (error) {
    next(error);
  }
};

export const requirePublicChatPermission = (
  dependencies: PermissionDependencies,
  permission: PublicChatPermission,
): RequestHandler => async (_req, res, next) => {
  try {
    const { workspaceId, authPrincipal } = res.locals as {
      workspaceId?: string;
      authPrincipal?: AuthenticatedPrincipal;
    };
    const resolvedWorkspaceId = workspaceId ?? (authPrincipal?.type === "public_chat_session" ? authPrincipal.workspaceId : undefined);
    await dependencies.accountAccessService.requirePermission({
      workspaceId: resolvedWorkspaceId,
      principal: authPrincipal,
      permission,
    });
    next();
  } catch (error) {
    next(error);
  }
};
