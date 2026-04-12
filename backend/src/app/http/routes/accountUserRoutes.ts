import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";
import { validateBody } from "../middleware/validate.js";

export const createAccountInvitationSchema = z.object({
  email: z.string().email(),
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

export const createAccountUserRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();
  const authenticatedSession = requireSession(dependencies);

  router.get("/users", authenticatedSession, async (_req, res, next) => {
    try {
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const [users, invitations] = await Promise.all([
        dependencies.accountAccessService.listAccountUsers(accountId),
        dependencies.accountInvitationService.listForAccount(accountId),
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
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/accounts", authenticatedSession, async (_req, res, next) => {
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

  router.post("/accounts", authenticatedSession, validateBody(createAccountSchema), async (req, res, next) => {
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
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/invitations", authenticatedSession, validateBody(createAccountInvitationSchema), async (req, res, next) => {
    try {
      const { accountId, userId } = res.locals as { accountId: string; userId: string };
      const invitation = await dependencies.accountInvitationService.createInvitation({
        accountId,
        invitedByUserId: userId,
        email: req.body.email,
      });

      res.status(201).json(invitation);
    } catch (error) {
      next(error);
    }
  });

  router.post("/switch", authenticatedSession, validateBody(accountSwitchSchema), async (req, res, next) => {
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
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/", authenticatedSession, validateBody(renameAccountSchema), async (req, res, next) => {
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
  });

  router.delete("/users/:membershipId", authenticatedSession, async (req, res, next) => {
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
