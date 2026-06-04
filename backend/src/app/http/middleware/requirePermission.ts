import type { Request, RequestHandler, Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type {
  AccountPermission,
  AuthenticatedPrincipal,
} from "../../../modules/account/services/accountAccessService.js";

export type PermissionDependencies = {
  accountAccessService: Pick<AppDependencies["accountAccessService"], "requirePermission">;
};

type WorkspacePermissionDependencies = Pick<AppDependencies, "accountAccessService">;

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
  permission: AccountPermission,
): RequestHandler => async (_req, res, next) => {
  try {
    const { workspaceId, authPrincipal } = res.locals as {
      workspaceId?: string;
      authPrincipal?: AuthenticatedPrincipal;
    };
    const resolvedWorkspaceId = workspaceId ?? (authPrincipal?.type === "public_chat_session" ? authPrincipal.workspaceId : undefined);
    await dependencies.accountAccessService.requirePermission({
      accountId: `public:${resolvedWorkspaceId ?? "unknown"}`,
      workspaceId: resolvedWorkspaceId,
      principal: authPrincipal,
      permission,
    });
    next();
  } catch (error) {
    next(error);
  }
};
