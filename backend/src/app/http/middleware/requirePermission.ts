import type { Request, RequestHandler, Response } from "express";

import type { AccountMembershipRole } from "../../../db/repositories/accountMembershipRepository.js";
import {
  workspaceRoleAllows,
  type AccountPermission,
  type AuthenticatedPrincipal,
  type PublicChatPermission,
} from "../../../modules/account/services/accountAccessService.js";

interface PermissionDependencies {
  accountAccessService: {
    /**
     * Resolves to the teammate's effective role the check allowed, when it looked one up; a narrower
     * access port that resolves nothing leaves later permissions to `hasPermission`.
     */
    requirePermission(input: {
      accountId?: string | null;
      userId?: string | null;
      principal?: AuthenticatedPrincipal | null;
      permission: AccountPermission | PublicChatPermission;
      workspaceId?: string | null;
    }): Promise<AccountMembershipRole | null | void>;
  };
}

/**
 * The effective role a workspace permission check resolved for the caller, kept on the request so
 * a later permission on the same workspace is weighed from it rather than looked up again.
 */
interface CheckedWorkspaceRole {
  workspaceId: string;
  role: AccountMembershipRole;
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
 * middleware, which has already placed the workspace in the caller's account and, for a teammate,
 * resolved the role this weighs `permission` by; the access service decides it otherwise.
 */
export const holdsWorkspacePermission = (
  dependencies: PermissionCheckDependencies,
  res: Response,
  permission: AccountPermission,
): Promise<boolean> => {
  const { accountId, userId, workspaceId, authPrincipal, checkedWorkspaceRole } = res.locals as {
    accountId: string;
    userId?: string;
    workspaceId?: string;
    authPrincipal?: AuthenticatedPrincipal;
    checkedWorkspaceRole?: CheckedWorkspaceRole;
  };
  if (checkedWorkspaceRole && checkedWorkspaceRole.workspaceId === workspaceId) {
    return Promise.resolve(workspaceRoleAllows(checkedWorkspaceRole.role, permission));
  }
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
    const checkedWorkspaceId = resolveWorkspaceId?.(req, res) ?? workspaceId;
    const role = await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      principal: authPrincipal,
      permission,
      workspaceId: checkedWorkspaceId,
    });
    if (role && checkedWorkspaceId) {
      const checked: CheckedWorkspaceRole = { workspaceId: checkedWorkspaceId, role };
      res.locals.checkedWorkspaceRole = checked;
    }
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
