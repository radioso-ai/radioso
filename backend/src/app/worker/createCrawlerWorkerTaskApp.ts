import express from "express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { createRequestTelemetryMiddleware } from "../../shared/observability/telemetry/telemetryService.js";
import { badRequest } from "../../shared/domain/errors.js";
import { createErrorHandler } from "../http/middleware/errorHandler.js";
import { createHttpTracingMiddleware } from "../http/middleware/tracingMiddleware.js";
import type { AppDependencies } from "../server/types.js";
import {
  createCrawlerWorkerTaskRoutes,
  type CrawlerWorkerTaskRouteOptions,
} from "./crawlerWorkerTaskRoutes.js";
import { createWorkerTaskAuthMiddleware } from "./workerTaskAuthMiddleware.js";

export const createCrawlerWorkerTaskApp = (
  dependencies: AppDependencies,
  routeOptions: CrawlerWorkerTaskRouteOptions = {},
) => {
  const app = express();

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
  app.use(createHttpTracingMiddleware());
  app.use(createRequestTelemetryMiddleware(dependencies.telemetryService));
  app.use("/internal/tasks", createWorkerTaskAuthMiddleware(dependencies.env.WORKER_TASK_AUTH_TOKEN));
  app.use(express.json({ limit: "1mb" }));
  app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError) {
      next(badRequest("Invalid JSON request body"));
      return;
    }
    next(error);
  });
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(createCrawlerWorkerTaskRoutes(dependencies, routeOptions));
  app.use(createErrorHandler(dependencies.errorReportingService));

  return app;
};
