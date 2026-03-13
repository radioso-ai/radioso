import cookieParser from "cookie-parser";
import express from "express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { errorHandler } from "../http/middleware/errorHandler.js";
import { createApiRouter } from "../http/routes/index.js";
import type { AppDependencies } from "./types.js";

export const createApp = (dependencies: AppDependencies) => {
  const app = express();

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(cookieParser());
  app.use(createApiRouter(dependencies));
  app.use(errorHandler);

  return app;
};
