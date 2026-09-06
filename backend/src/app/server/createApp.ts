import cookieParser from "cookie-parser";
import express from "express";
import swaggerUi from "swagger-ui-express";

import { createHttpLogger } from "../../shared/observability/logger.js";
import { createRequestTelemetryMiddleware } from "../../shared/observability/telemetry/telemetryService.js";
import { badRequest, payloadTooLarge } from "../../shared/domain/errors.js";
import { createErrorHandler } from "../http/middleware/errorHandler.js";
import { createHttpTracingMiddleware } from "../http/middleware/tracingMiddleware.js";
import { createRequestAuditContextMiddleware } from "../http/middleware/requestAuditContextMiddleware.js";
import { createOpenApiDocument } from "../http/openapi/openApiDocument.js";
import { createApiRouter } from "../http/routes/index.js";
import type { AppDependencies } from "./types.js";

/**
 * Request bodies are captured (rawBody + parsed) only for the content types Radioso parses:
 * JSON for normal APIs, and `application/x-www-form-urlencoded` for Slack interactivity
 * callbacks and OAuth token exchanges. Slack needs the original bytes for signature
 * verification; OAuth relies on the same parser accepting media-type casing consistently.
 * Everything else skips body capture.
 */
export const shouldCaptureRequestBody = (contentType: string | undefined): boolean =>
  typeof contentType === "string"
  && (/^application\/json\b/i.test(contentType) || /^application\/x-www-form-urlencoded\b/i.test(contentType));

export const captureRequestBody = async (req: express.Request, _res: express.Response, next: express.NextFunction): Promise<void> => {
  if (!shouldCaptureRequestBody(req.headers["content-type"])) {
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

    const contentType = req.headers["content-type"] ?? "";
    if (typeof contentType === "string" && /^application\/x-www-form-urlencoded\b/i.test(contentType)) {
      req.body = Object.fromEntries(new URLSearchParams(rawBody.toString("utf8")));
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
};

export const createApp = (dependencies: AppDependencies) => {
  const app = express();

  if (dependencies.env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", dependencies.env.TRUST_PROXY_HOPS);
  } else {
    app.set("trust proxy", false);
  }

  app.disable("x-powered-by");
  app.use(createHttpLogger(dependencies.logger));
  app.use(createRequestAuditContextMiddleware());
  app.use(createHttpTracingMiddleware());
  app.use(createRequestTelemetryMiddleware(dependencies.telemetryService));
  app.use(captureRequestBody);
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
