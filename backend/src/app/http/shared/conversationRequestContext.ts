import type { Request } from "express";

import {
  deriveConversationRequestContext,
  type DeriveConversationRequestContextResult,
  type EdgeFactsRejectionReason,
} from "../../../shared/domain/conversationRequestContext.js";
import type { AppDependencies } from "../../server/types.js";

type RequestContextDependencies = Pick<AppDependencies, "env" | "visitorGeoResolver">;

/** The route *pattern* (e.g. `/api/v1/public/chat/:token`), never the resolved URL — keeps a public chat token out of logs and metric labels. */
const routePattern = (req: Pick<Request, "baseUrl" | "route">): string => {
  const pattern = typeof req.route?.path === "string" ? req.route.path : "";
  return `${req.baseUrl}${pattern}`;
};

/**
 * FR-023 wiring for an Express request: resolves the trusted-proxy-hop and
 * edge-proof-secret configuration once per request and derives the
 * conversation's request context. Kept out of route handlers so they stay
 * readable top-to-bottom (CLAUDE.md).
 */
export const resolveConversationRequestContext = (
  dependencies: RequestContextDependencies,
  req: Pick<Request, "headers" | "socket" | "method" | "originalUrl" | "path">,
): DeriveConversationRequestContextResult => deriveConversationRequestContext({
  headers: req.headers,
  socketAddress: req.socket?.remoteAddress ?? null,
  trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  secret: dependencies.env.RADIOSO_EDGE_PROOF_SECRET,
  method: req.method,
  path: req.originalUrl.split("?", 1)[0] ?? req.path,
  geoResolver: dependencies.visitorGeoResolver,
});

/**
 * Spec 1277 Observability: `edge_facts_proof_rejected_total{reason}` plus a
 * debug log carrying only `reason` and the route — never an address, header,
 * or other request detail.
 */
export const recordEdgeFactsProofRejected = (
  dependencies: Pick<AppDependencies, "metricsRegistry" | "logger">,
  reason: EdgeFactsRejectionReason,
  req: Pick<Request, "baseUrl" | "route">,
): void => {
  const route = routePattern(req);
  dependencies.metricsRegistry?.incrementCounter("edge_facts_proof_rejected_total", {
    help: "Edge-facts proof rejections by reason.",
    labels: { reason },
  });
  dependencies.logger.debug({ reason, route }, "Edge facts proof rejected");
};
