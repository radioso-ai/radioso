import type { RequestHandler } from "express";

import { setActiveSpanAttributes, startActiveSpan } from "../../../shared/observability/tracing/index.js";

const routePath = (req: Parameters<RequestHandler>[0]): string | undefined => {
  const baseUrl = req.baseUrl || "";
  const route = req.route as { path?: unknown } | undefined;
  const routePattern = typeof route?.path === "string" ? route.path : undefined;
  return routePattern ? `${baseUrl}${routePattern}` : undefined;
};

const requestId = (req: Parameters<RequestHandler>[0]): string | undefined => {
  const value = (req as { id?: unknown }).id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const createHttpTracingMiddleware = (): RequestHandler => (req, res, next) => {
  void startActiveSpan(
    "http.server.request",
    {
      "http.request.method": req.method,
      "radioso.request_id": requestId(req),
    },
    async () => {
      await new Promise<void>((resolve) => {
        const finish = () => {
          setActiveSpanAttributes({
            "http.response.status_code": res.statusCode,
            "http.route": routePath(req),
          });
          resolve();
        };
        res.once("finish", finish);
        res.once("close", finish);
        next();
      });
    },
  );
};
