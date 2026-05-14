import type { RequestHandler } from "express";

import type { AgentSurfaceExtensionRegistry } from "../../../modules/agents/public.js";
import { notFound } from "../../../shared/domain/errors.js";

/**
 * Block a request when the named surface extension isn't registered. The
 * route stays defined in OSS for organizational convenience, but it's inert
 * unless a plugin (typically EE) registers a matching extension during
 * composition.
 *
 * Returns 404 — never reveals that the feature is conditionally gated.
 */
export const requireSurfaceExtension = (
  registry: AgentSurfaceExtensionRegistry,
  key: string,
): RequestHandler => (_req, _res, next) => {
  if (registry.has(key)) {
    next();
    return;
  }
  next(notFound("Not found"));
};
