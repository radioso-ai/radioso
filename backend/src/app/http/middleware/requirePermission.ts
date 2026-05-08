import type { Request, RequestHandler, Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { AccountPermission } from "../../../modules/account/services/accountAccessService.js";

export type PermissionDependencies = Pick<AppDependencies, "accountAccessService">;

export const requireAccountPermission = (
  dependencies: PermissionDependencies,
  permission: AccountPermission,
): RequestHandler => async (_req, res, next) => {
  try {
    const { accountId, userId, supportImpersonationId } = res.locals as {
      accountId: string;
      userId?: string;
      supportImpersonationId?: string;
    };
    await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      permission,
      supportImpersonationId,
    });
    next();
  } catch (error) {
    next(error);
  }
};

export const requireWorkspacePermission = (
  dependencies: PermissionDependencies,
  permission: AccountPermission,
  resolveWorkspaceId?: (req: Request, res: Response) => string | null | undefined,
): RequestHandler => async (req, res, next) => {
  try {
    const { accountId, userId, workspaceId, supportImpersonationId } = res.locals as {
      accountId: string;
      userId?: string;
      workspaceId?: string;
      supportImpersonationId?: string;
      authMode?: string;
    };
    if (res.locals.authMode === "bearer" && permission.startsWith("workspace.") && !permission.startsWith("workspace.token.")) {
      next();
      return;
    }
    await dependencies.accountAccessService.requirePermission({
      accountId,
      userId,
      permission,
      workspaceId: resolveWorkspaceId?.(req, res) ?? workspaceId,
      supportImpersonationId,
    });
    next();
  } catch (error) {
    next(error);
  }
};
