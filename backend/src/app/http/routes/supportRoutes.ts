import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { validateBody } from "../middleware/validate.js";

export const approveSupportImpersonationSchema = z.object({
  accountId: z.string().uuid(),
  staffUserId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(1000),
});

export const supportImpersonationParamsSchema = z.object({
  id: z.string().uuid(),
});

type SupportRouteDependencies = SessionDependencies & Pick<AppDependencies, "supportImpersonationService">;

export const createSupportRoutes = (dependencies: SupportRouteDependencies): Router => {
  const router = Router();
  const staffSession = requireSession(dependencies, { requireActiveMembership: false });

  router.post("/impersonations", staffSession, validateBody(approveSupportImpersonationSchema), async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const session = await dependencies.supportImpersonationService.approve({
        accountId: req.body.accountId,
        staffUserId: req.body.staffUserId ?? userId,
        approverUserId: userId,
        reason: req.body.reason,
      });
      res.status(201).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.post("/impersonations/:id/start", staffSession, async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const { id } = supportImpersonationParamsSchema.parse(req.params);
      const session = await dependencies.supportImpersonationService.start({ id, staffUserId: userId });
      res.status(200).json(session);
    } catch (error) {
      next(error);
    }
  });

  router.post("/impersonations/:id/end", staffSession, async (req, res, next) => {
    try {
      const { userId } = res.locals as { userId: string };
      const { id } = supportImpersonationParamsSchema.parse(req.params);
      const session = await dependencies.supportImpersonationService.end({ id, staffUserId: userId });
      res.status(200).json(session);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
