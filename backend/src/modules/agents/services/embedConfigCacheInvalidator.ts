/**
 * Port the agent service uses to drop the CDN-cached website embed config for a
 * launch token after its settings change, so operator edits propagate without
 * waiting for the cache TTL to expire.
 *
 * The default is a no-op: caching is opt-in infrastructure (an external HTTPS
 * load balancer + Cloud CDN), so most deployments — local, tests, and any
 * environment served directly from Cloud Run — have nothing to invalidate.
 * The concrete Cloud CDN adapter lives in `app/composition`.
 */
export interface EmbedConfigCacheInvalidator {
  /** Invalidate the cached embed config for a single launch token. Never throws. */
  invalidateForToken(token: string): Promise<void>;
}

export const noopEmbedConfigCacheInvalidator: EmbedConfigCacheInvalidator = {
  async invalidateForToken(): Promise<void> {
    // Nothing to invalidate without a CDN in front of the frontend.
  },
};

/** Path served by the frontend embed-config route, matched by the CDN cache rule. */
export const embedConfigCachePath = (token: string): string =>
  `/api/embed/config/${encodeURIComponent(token)}`;
