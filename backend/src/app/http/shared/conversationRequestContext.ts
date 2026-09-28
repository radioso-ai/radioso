import type { Request, Response } from "express";

import {
  deriveConversationRequestContext,
  type DeriveConversationRequestContextResult,
} from "../../../shared/domain/conversationRequestContext.js";
import { readPublishedEdgeFactsEnvelope } from "../middleware/requestSource.js";
import type { AppDependencies } from "../../server/types.js";

type RequestContextDependencies = Pick<AppDependencies, "env" | "visitorGeoResolver">;

/**
 * FR-023 wiring for an Express request: resolves the trusted-proxy-hop and
 * edge-proof-secret configuration once per request and derives the
 * conversation's request context. It reuses the envelope reading the
 * request-source middleware published, which also owns counting a rejected
 * proof, so a rejection is counted once per request. Kept out of route
 * handlers so they stay readable top-to-bottom (CLAUDE.md).
 */
export const resolveConversationRequestContext = (
  dependencies: RequestContextDependencies,
  req: Pick<Request, "headers" | "socket" | "method" | "originalUrl" | "path">,
  res: Pick<Response, "locals">,
): DeriveConversationRequestContextResult => deriveConversationRequestContext({
  headers: req.headers,
  socketAddress: req.socket?.remoteAddress ?? null,
  trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  secret: dependencies.env.RADIOSO_EDGE_PROOF_SECRET,
  method: req.method,
  path: req.originalUrl.split("?", 1)[0] ?? req.path,
  envelope: readPublishedEdgeFactsEnvelope(res),
  geoResolver: dependencies.visitorGeoResolver,
});
