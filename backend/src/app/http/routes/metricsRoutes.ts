import { Router } from "express";

import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

export const createMetricsRoutes = (metricsRegistry: MetricsRegistry): Router => {
  const router = Router();

  router.get("/", (_req, res) => {
    res
      .status(200)
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(metricsRegistry.renderPrometheus());
  });

  return router;
};
