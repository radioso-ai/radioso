import cookieParser from "cookie-parser";
import express from "express";
import swaggerUi from "swagger-ui-express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { createRequestTelemetryMiddleware } from "../../shared/observability/telemetry/telemetryService.js";
import { badRequest, payloadTooLarge } from "../../shared/domain/errors.js";
import { createErrorHandler } from "../http/middleware/errorHandler.js";
import { createHttpTracingMiddleware } from "../http/middleware/tracingMiddleware.js";
import { createOpenApiDocument } from "../http/openapi/openApiDocument.js";
import { createApiRouter } from "../http/routes/index.js";
import { mountMergedMcp } from "./mcpMount.js";
import type { AppDependencies } from "./types.js";

export const createApp = (dependencies: AppDependencies) => {
  const app = express();

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
  app.use(createHttpTracingMiddleware());
  app.use(createRequestTelemetryMiddleware(dependencies.telemetryService));
  mountMergedMcp(app, dependencies);
  app.use(async (req, _res, next) => {
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json\b/i.test(contentType)) {
      next();
      return;
    }

    try {
      const chunks: Buffer[] = [];
      let size = 0;

      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 1024 * 1024) {
          next(payloadTooLarge());
          return;
        }
        chunks.push(buffer);
      }

      const rawBody = Buffer.concat(chunks);
      (req as typeof req & { rawBody?: Buffer }).rawBody = rawBody;

      if (rawBody.length === 0) {
        req.body = {};
        next();
        return;
      }

      req.body = JSON.parse(rawBody.toString("utf8"));
      next();
    } catch (error) {
      if (error instanceof SyntaxError) {
        next(badRequest("Invalid JSON request body"));
        return;
      }
      next(error);
    }
  });
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
  app.use(createErrorHandler(dependencies.errorReportingService));

  return app;
};
