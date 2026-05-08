import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { requireAccountPermission, requireWorkspacePermission } from "../middleware/requirePermission.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";

export const createAccountInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export const accountMembershipParamsSchema = z.object({
  membershipId: z.string().uuid(),
});

export const accountSwitchSchema = z.object({
  accountId: z.string().uuid(),
  preferredWorkspaceId: z.string().uuid().optional(),
});

export const createAccountSchema = z.object({
  organizationName: z.string().trim().min(1).max(80),
});

export const renameAccountSchema = z.object({
  organizationName: z.string().trim().min(1).max(80),
});

export const updateMembershipRoleSchema = z.object({
  role: z.enum(["admin", "member"]),
});

export const workspaceGrantParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const workspaceGrantSchema = z.object({
  role: z.enum(["admin", "member"]),
});

const requireWorkspaceGrantParams = (params: unknown): z.infer<typeof workspaceGrantParamsSchema> => {
  const parsedParams = workspaceGrantParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    throw badRequest("Invalid workspace grant parameters", parsedParams.error.flatten());
  }

  return parsedParams.data;
};

type AccountUserRouteDependencies = SessionDependencies & Pick<
  AppDependencies,
  "accountInvitationService" | "supportImpersonationService"
>;

export const createAccountUserRoutes = (dependencies: AccountUserRouteDependencies): Router => {
  const router = Router();
  const authenticatedSession = requireSession(dependencies);
  const authenticatedUserSession = requireSession(dependencies, { requireActiveMembership: false });

  router.get("/users", authenticatedSession, requireAccountPermission(dependencies, "account.users.manage"), async (_req, res, next) => {
    try {
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const [users, invitations] = await Promise.all([
        dependencies.accountAccessService.listAccountUsers(accountId),
        dependencies.accountInvitationService.listForAccount(accountId),
      ]);
      const [workspaceGrants, supportImpersonations] = await Promise.all([
        dependencies.accountAccessService.listWorkspaceGrants(accountId),
        dependencies.supportImpersonationService.listForAccount(accountId),
      ]);

      res.status(200).json({
        accountId,
        currentUserId: userId,
        users: users.map((user) => ({
          membershipId: user.id,
          userId: user.userId,
          email: user.email,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt.toISOString(),
        })),
        invitations,
        workspaceGrants,
        supportImpersonations,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts", authenticatedUserSession, async (_req, res, next) => {
    try {
      const { userId, accountId } = res.locals as { userId: string; accountId: string };
      const accounts = await dependencies.authService.listAccessibleAccounts(userId);
      res.status(200).json({
        currentAccountId: accountId,
        accounts,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/accounts", authenticatedUserSession, validateBody(createAccountSchema), async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const result = await dependencies.authService.createOrganization({
        userId,
        organizationName: req.body.organizationName,
      });
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(201).json({
        userId: result.userId,
        accountId: result.accountId,
        organizationName: result.organizationName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        workspacePublicRouteKey: result.workspacePublicRouteKey,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/invitations",
    authenticatedSession,
    requireAccountPermission(dependencies, "account.users.manage"),
    validateBody(createAccountInvitationSchema),
    async (req, res, next) => {
      try {
        const { accountId, userId } = res.locals as { accountId: string; userId: string };
        const invitation = await dependencies.accountInvitationService.createInvitation({
          accountId,
          invitedByUserId: userId,
          email: req.body.email,
          role: req.body.role,
        });

        res.status(201).json(invitation);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/switch", authenticatedUserSession, validateBody(accountSwitchSchema), async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const result = await dependencies.authService.switchAccount({
        userId,
        targetAccountId: req.body.accountId,
        preferredWorkspaceId: req.body.preferredWorkspaceId,
      });
      res.setHeader("Set-Cookie", result.sessionCookie);
      res.status(200).json({
        userId: result.userId,
        accountId: result.accountId,
        organizationName: result.organizationName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        workspacePublicRouteKey: result.workspacePublicRouteKey,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/",
    authenticatedSession,
    requireAccountPermission(dependencies, "account.organization.rename"),
    validateBody(renameAccountSchema),
    async (req, res, next) => {
      try {
        const { accountId, userId } = res.locals as { accountId: string; userId: string };
        const result = await dependencies.authService.renameOrganization({
          accountId,
          userId,
          organizationName: req.body.organizationName,
        });
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/users/:membershipId",
    authenticatedSession,
    requireAccountPermission(dependencies, "account.membership.role.update"),
    validateBody(updateMembershipRoleSchema),
    async (req, res, next) => {
      try {
        const { accountId, userId } = res.locals as { accountId: string; userId: string };
        const { membershipId } = accountMembershipParamsSchema.parse(req.params);
        const membership = await dependencies.accountAccessService.updateMembershipRole({
          accountId,
          actorUserId: userId,
          membershipId,
          role: req.body.role,
        });
        res.status(200).json({
          membershipId: membership.id,
          userId: membership.userId,
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt.toISOString(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    "/workspaces/:workspaceId/grants/:userId",
    authenticatedSession,
    requireWorkspacePermission(dependencies, "account.membership.role.update", (req) => requireWorkspaceGrantParams(req.params).workspaceId),
    validateBody(workspaceGrantSchema),
    async (req, res, next) => {
      try {
        const { accountId, userId: actorUserId } = res.locals as { accountId: string; userId: string };
        const { workspaceId, userId } = requireWorkspaceGrantParams(req.params);
        const grant = await dependencies.accountAccessService.setWorkspaceGrant({
          accountId,
          actorUserId,
          workspaceId,
          userId,
          role: req.body.role,
        });
        res.status(200).json({
          workspaceId: grant.workspaceId,
          userId: grant.userId,
          role: grant.role,
          createdAt: grant.createdAt.toISOString(),
          updatedAt: grant.updatedAt.toISOString(),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    "/workspaces/:workspaceId/grants/:userId",
    authenticatedSession,
    requireWorkspacePermission(dependencies, "account.membership.role.update", (req) => requireWorkspaceGrantParams(req.params).workspaceId),
    async (req, res, next) => {
      try {
        const { accountId, userId: actorUserId } = res.locals as { accountId: string; userId: string };
        const { workspaceId, userId } = requireWorkspaceGrantParams(req.params);
        await dependencies.accountAccessService.removeWorkspaceGrant({
          accountId,
          actorUserId,
          workspaceId,
          userId,
        });
        res.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete("/users/:membershipId", authenticatedSession, requireAccountPermission(dependencies, "account.membership.remove"), async (req, res, next) => {
    try {
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const { membershipId } = accountMembershipParamsSchema.parse(req.params);
      await dependencies.accountAccessService.removeUserAccess({
        accountId,
        actorUserId: userId,
        membershipId,
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
};
