import { describe, expect, it, vi } from "vitest";

import {
  createCloudCdnEmbedConfigCacheInvalidator,
  resolveEmbedConfigCacheInvalidator,
} from "../../src/app/composition/builtIn/cloudCdnEmbedConfigCacheInvalidator.js";
import { noopEmbedConfigCacheInvalidator } from "../../src/modules/agents/services/embedConfigCacheInvalidator.js";

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response;

describe("embed config cache invalidator", () => {
  it("falls back to the no-op when the project or url map is missing", () => {
    expect(resolveEmbedConfigCacheInvalidator({ urlMap: "lb" })).toBe(noopEmbedConfigCacheInvalidator);
    expect(resolveEmbedConfigCacheInvalidator({ projectId: "p" })).toBe(noopEmbedConfigCacheInvalidator);
  });

  it("posts an invalidateCache request for the token's config path", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse());
    const invalidator = createCloudCdnEmbedConfigCacheInvalidator({
      projectId: "proj-1",
      urlMap: "radioso-live-frontend-lb",
      fetchImpl: fetchImpl,
      accessTokenProvider: async () => "token-abc",
    });

    await invalidator.invalidateForToken("tok/123");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://compute.googleapis.com/compute/v1/projects/proj-1/global/urlMaps/radioso-live-frontend-lb/invalidateCache",
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    expect(JSON.parse(init?.body as string)).toEqual({ path: "/api/embed/config/tok%2F123" });
  });

  it("never throws when invalidation fails", async () => {
    const invalidator = createCloudCdnEmbedConfigCacheInvalidator({
      projectId: "proj-1",
      urlMap: "lb",
      fetchImpl: async () => {
        throw new Error("network down");
      },
      accessTokenProvider: async () => "token-abc",
      logger: { warn: vi.fn() },
    });

    await expect(invalidator.invalidateForToken("tok")).resolves.toBeUndefined();
  });

  it("skips the request when no access token is available", async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const invalidator = createCloudCdnEmbedConfigCacheInvalidator({
      projectId: "proj-1",
      urlMap: "lb",
      fetchImpl: fetchImpl,
      accessTokenProvider: async () => null,
      logger: { warn: vi.fn() },
    });

    await invalidator.invalidateForToken("tok");

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
