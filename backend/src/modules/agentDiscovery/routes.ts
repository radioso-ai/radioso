import { Router, type RequestHandler } from "express";

import { createPreAuthSourceRateLimiter } from "../../app/http/middleware/preAuthSourceRateLimiter.js";
import type { AppDependencies } from "../../app/server/types.js";
import { notFound } from "../../shared/domain/errors.js";
import type { AgentPublicProfile } from "./contracts/agentPublicProfile.js";
import { renderA2aAgentCard } from "./domain/renderA2aAgentCard.js";
import { renderAiCatalog } from "./domain/renderAiCatalog.js";
import { renderMcpServerCard } from "./domain/renderMcpServerCard.js";

type Dependencies = Pick<AppDependencies,
  "env" | "abuseControlService" | "agentPublicProfile" | "logger" | "metricsRegistry"
>;

type DocumentKind = "a2a" | "server_card" | "catalog";

/** Cards are public, immutable-until-republished documents; five minutes is FR-022's budget. */
const CACHE_CONTROL = "public, max-age=300";

/**
 * A public id is 25 characters. The bound is generous and structural: it keeps a junk path
 * segment out of the database without teaching this route what an id looks like.
 */
const MAX_PUBLIC_ID_LENGTH = 64;

export const createAgentDiscoveryRoutes = (dependencies: Dependencies): Router => {
  const router = Router();

  const rateLimit = createPreAuthSourceRateLimiter({
    service: dependencies.abuseControlService,
    scope: "api.agent_discovery_document",
    // Bounded like the other unauthenticated public reads. A card is cheap and cacheable,
    // so the budget exists to stop a loop, not to ration discovery.
    limit: dependencies.env.PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
    trustedProxyHops: dependencies.env.RADIOSO_TRUSTED_PROXY_HOPS,
  });

  const observe = (kind: DocumentKind, outcome: "served" | "not_found" | "not_modified"): void => {
    dependencies.metricsRegistry?.incrementCounter("agent_discovery_card_requests_total", {
      help: "Public agent discovery documents served, by document kind and outcome.",
      // No public id and no agent id: the documents are per-agent, the metric is not.
      labels: { kind, outcome },
    });
  };

  const serve = (kind: DocumentKind, render: (profile: AgentPublicProfile) => unknown): RequestHandler =>
    async (req, res, next) => {
      try {
        const publicId = String(req.params.publicId);
        const profile = publicId.length <= MAX_PUBLIC_ID_LENGTH
          ? await dependencies.agentPublicProfile.load(publicId)
          : null;
        if (!profile) {
          // Unknown, card switched off, unpublished, and deleted answer identically: the
          // 404 is the whole answer, and a caller learns nothing it could not have guessed.
          observe(kind, "not_found");
          dependencies.logger.debug({ document: kind }, "Agent discovery document not found");
          next(notFound("Not found"));
          return;
        }
        res.setHeader("Cache-Control", CACHE_CONTROL);
        res.status(200).json(render(profile));
        // Express answers a matching `If-None-Match` with 304 from its own weak ETag.
        observe(kind, res.statusCode === 304 ? "not_modified" : "served");
      } catch (error) {
        next(error);
      }
    };

  router.get("/agent-card/:publicId.json", rateLimit, serve("a2a", renderA2aAgentCard));
  router.get("/mcp/server-card/:publicId.json", rateLimit, serve("server_card", renderMcpServerCard));
  router.get("/ai-catalog/:publicId.json", rateLimit, serve("catalog", renderAiCatalog));

  return router;
};
