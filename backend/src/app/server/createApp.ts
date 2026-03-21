import cookieParser from "cookie-parser";
import express from "express";
import swaggerUi from "swagger-ui-express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { errorHandler } from "../http/middleware/errorHandler.js";
import { createOpenApiDocument } from "../http/openapi/document.js";
import { createApiRouter } from "../http/routes/index.js";
import type { AppDependencies } from "./types.js";

export const createApp = (dependencies: AppDependencies) => {
  const app = express();

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
  app.use(express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(cookieParser());
  if (dependencies.env.NODE_ENV !== "test") {
    const openApiDocument = createOpenApiDocument({
      sessionCookieName: dependencies.env.SESSION_COOKIE_NAME,
    });
    app.get("/openapi.json", (_req, res) => {
      res.status(200).json(openApiDocument);
    });
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }
  app.use(createApiRouter(dependencies));
  app.use(errorHandler);

  return app;
};
