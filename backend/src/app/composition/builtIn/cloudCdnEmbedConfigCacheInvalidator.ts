import {
  embedConfigCachePath,
  noopEmbedConfigCacheInvalidator,
  type EmbedConfigCacheInvalidator,
} from "../../../modules/agents/public.js";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

interface CloudCdnInvalidatorLogger {
  warn?: (payload: Record<string, unknown>, message: string) => void;
}

export interface CloudCdnEmbedConfigCacheInvalidatorOptions {
  /** GCP project that owns the URL map (from GOOGLE_CLOUD_PROJECT). */
  projectId: string;
  /** Name of the global URL map fronting the frontend (from RADIOSO_CDN_URL_MAP). */
  urlMap: string;
  logger?: CloudCdnInvalidatorLogger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the Cloud Run metadata server. */
  accessTokenProvider?: () => Promise<string | null>;
}

const fetchMetadataAccessToken = async (fetchImpl: typeof fetch): Promise<string | null> => {
  const response = await fetchImpl(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  return typeof payload?.access_token === "string" ? payload.access_token : null;
};

/**
 * Invalidates a single embed-config path on Cloud CDN via the Compute Engine
 * `urlMaps.invalidateCache` API. Best effort: any failure is logged and
 * swallowed so a CDN hiccup never blocks an operator's settings save.
 */
export const createCloudCdnEmbedConfigCacheInvalidator = (
  options: CloudCdnEmbedConfigCacheInvalidatorOptions,
): EmbedConfigCacheInvalidator => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const getAccessToken = options.accessTokenProvider ?? (() => fetchMetadataAccessToken(fetchImpl));
  const endpoint = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(
    options.projectId,
  )}/global/urlMaps/${encodeURIComponent(options.urlMap)}/invalidateCache`;

  return {
    async invalidateForToken(token: string): Promise<void> {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) {
          options.logger?.warn?.({ urlMap: options.urlMap }, "Skipping CDN invalidation: no access token");
          return;
        }
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: embedConfigCachePath(token) }),
        });
        if (!response.ok) {
          options.logger?.warn?.(
            { urlMap: options.urlMap, status: response.status },
            "CDN cache invalidation request was rejected",
          );
        }
      } catch (error) {
        options.logger?.warn?.(
          { urlMap: options.urlMap, error: error instanceof Error ? error.message : String(error) },
          "CDN cache invalidation request failed",
        );
      }
    },
  };
};

/**
 * Builds the Cloud CDN invalidator when both the project and URL map are
 * configured; otherwise returns the no-op (no CDN to invalidate).
 */
export const resolveEmbedConfigCacheInvalidator = (config: {
  projectId?: string;
  urlMap?: string;
  logger?: CloudCdnInvalidatorLogger;
}): EmbedConfigCacheInvalidator => {
  if (!config.projectId || !config.urlMap) {
    return noopEmbedConfigCacheInvalidator;
  }
  return createCloudCdnEmbedConfigCacheInvalidator({
    projectId: config.projectId,
    urlMap: config.urlMap,
    logger: config.logger,
  });
};
