import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";

export const createAccountRoutes = (_dependencies: Pick<AppDependencies, "env">): Router => {
  const router = Router();
  return router;
};
