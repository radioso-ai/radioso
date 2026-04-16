import express from "express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { badRequest } from "../../shared/domain/errors.js";
import { errorHandler } from "../http/middleware/errorHandler.js";
import type { AppDependencies } from "../server/types.js";
import { createWorkerTaskRoutes } from "./workerTaskRoutes.js";

export const createWorkerTaskApp = (dependencies: AppDependencies) => {
  const app = express();

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
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
  app.use(createWorkerTaskRoutes(dependencies));
  app.use(errorHandler);

  return app;
};
