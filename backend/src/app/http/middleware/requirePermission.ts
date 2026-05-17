import type { Request, RequestHandler, Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type {
  AccountPermission,
  AuthenticatedPrincipal,
} from "../../../modules/account/services/accountAccessService.js";

export type PermissionDependencies = Pick<AppDependencies, "accountAccessService">;

export const requireAccountPermission = (
  dependencies: PermissionDependencies,
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
  dependencies: PermissionDependencies,
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
