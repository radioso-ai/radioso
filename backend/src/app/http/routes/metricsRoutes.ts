import { timingSafeEqual } from "node:crypto";
import { Router } from "express";

import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";

const hasValidBearerToken = (authorizationHeader: string | undefined, expectedToken: string): boolean => {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    return false;
  }

  const providedToken = Buffer.from(authorizationHeader.slice("Bearer ".length));
  const expectedTokenBytes = Buffer.from(expectedToken);

  if (providedToken.length !== expectedTokenBytes.length) {
    return false;
  }

  return timingSafeEqual(providedToken, expectedTokenBytes);
};

export const createMetricsRoutes = (metricsRegistry: MetricsRegistry, metricsAuthToken: string): Router => {
  const router = Router();

  router.get("/", (req, res) => {
    if (!hasValidBearerToken(req.header("authorization"), metricsAuthToken)) {
      res
        .set("WWW-Authenticate", 'Bearer realm="metrics"')
        .status(401)
        .json({
          error: {
            code: "unauthorized",
            message: "Metrics authentication required",
          },
        });
      return;
    }

    res
      .status(200)
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(metricsRegistry.renderPrometheus());
  });

  return router;
};
