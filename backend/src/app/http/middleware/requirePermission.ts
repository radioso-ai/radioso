import type { Request, RequestHandler, Response } from "express";

import type {
  AccountPermission,
  AuthenticatedPrincipal,
  PublicChatPermission,
} from "../../../modules/account/services/accountAccessService.js";

export interface PermissionDependencies {
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
