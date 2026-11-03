import { Router } from "express";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

/**
 * Serves the Radioso Cloud plan catalog. Public and unauthenticated on purpose: the website
 * pricing page and unauthenticated signup flows read it before an account exists. Staff-only
 * numbers (`MODEL_SPEND_ESTIMATE`) are a separate export and never pass through here.
 */
export const createPlansRoutes = (): Router => {
  const router = Router();

  router.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(PLAN_CATALOG);
  });

  return router;
};
