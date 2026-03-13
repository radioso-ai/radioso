import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { requireSession } from "../middleware/requireSession.js";

export const createAccountRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/token", requireSession(dependencies), async (_req, res, next) => {
    try {
      const { accountId } = res.locals as { accountId: string };
      const result = await dependencies.authService.getAccountTokenForAccount(accountId);
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
