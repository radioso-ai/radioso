import type { RequestHandler } from "express";

import { matchedRoutePattern } from "../../../shared/observability/matchedRoute.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";

const requestId = (req: Parameters<RequestHandler>[0]): string | undefined => {
  const value = (req as { id?: unknown }).id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const createHttpTracingMiddleware = (): RequestHandler => (req, res, next) => {
  void traceOperation({
    name: "http.server.request",
    attributes: {
      "http.request.method": req.method,
      "radioso.request_id": requestId(req),
    },
    async run() {
      await new Promise<void>((resolve) => {
        const finish = () => {
          setTraceAttributes({
            "http.response.status_code": res.statusCode,
            "http.route": matchedRoutePattern(req),
          });
          resolve();
        };
        res.once("finish", finish);
        res.once("close", finish);
        next();
      });
    },
  });
};
