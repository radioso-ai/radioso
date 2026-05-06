import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { createWebsiteCrawlerRoutes } from "./routes.js";
import type { WebsiteCrawlerProvider } from "./provider.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0] & {
  websiteCrawlerProvider?: WebsiteCrawlerProvider;
};

const createProvider = (): WebsiteCrawlerProvider => ({
  name: "fake",
  crawl: vi.fn().mockResolvedValue({
    provider: "fake",
    runId: "run-1",
    status: "completed",
    pages: [{
      sourceUrl: "https://example.com/about",
      title: "About",
      content: "# About",
      metadata: {},
    }],
  }),
});

const createApp = (dependencies: Partial<RouteDependencies> = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use("/api/v1/ee/website-crawler", createWebsiteCrawlerRoutes({
    env: {
      SESSION_COOKIE_NAME: "radioso_session",
    },
    authService: {
      async authenticateSession(token: string) {
        if (token !== "valid-session") {
          throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
        }
        return {
          accountId: "account-1",
          userId: "user-1",
          sessionId: "session-1",
        };
      },
      async authenticateApiToken() {
        return {
          accountId: "account-1",
          workspaceId: "workspace-token",
        };
      },
    },
    accountAccessService: {
      async requireActiveMembership() {},
    },
    workspaceSessionService: {
      async resolve({ accountId, workspaceId }) {
        if (!workspaceId) {
          throw { statusCode: 400, code: "bad_request", message: "Workspace is required" };
        }
        if (workspaceId === "workspace-2") {
          return { accountId, workspaceId };
        }
        return { accountId, workspaceId };
      },
    },
    auditService: {
      record: vi.fn().mockResolvedValue(undefined),
    },
    abuseControlService: {
      enforce: vi.fn().mockResolvedValue(undefined),
    },
    documentIngestionService: {
      ingest: vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" }),
    },
    assertCrawlUrlAllowed: async () => undefined,
    ...dependencies,
  } as RouteDependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string; details?: unknown };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
        ...(payload.details ? { details: payload.details } : {}),
      },
    });
  });
  return app;
};

describe("enterprise website crawler routes", () => {
  it("returns unavailable when crawler provider is not configured", async () => {
    const response = await request(createApp())
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com" })
      .expect(503);

    expect(response.body.error).toEqual({
      code: "service_unavailable",
      message: "Enterprise website crawler is not configured",
    });
  });

  it("keeps crawler limit configuration failures scoped to crawler requests", async () => {
    const originalMaxLimit = process.env.EE_WEBSITE_CRAWLER_MAX_LIMIT;
    process.env.EE_WEBSITE_CRAWLER_MAX_LIMIT = "nope";
    try {
      const app = createApp({ websiteCrawlerProvider: createProvider() });
      const response = await request(app)
        .post("/api/v1/ee/website-crawler/crawl")
        .set("Cookie", "radioso_session=valid-session")
        .set("x-workspace-id", "workspace-1")
        .send({ url: "https://example.com" })
        .expect(503);

      expect(response.body.error).toEqual({
        code: "service_unavailable",
        message: "EE_WEBSITE_CRAWLER_MAX_LIMIT must be a positive integer",
        details: {
          invalidEnv: "EE_WEBSITE_CRAWLER_MAX_LIMIT",
        },
      });
    } finally {
      if (originalMaxLimit === undefined) {
        delete process.env.EE_WEBSITE_CRAWLER_MAX_LIMIT;
      } else {
        process.env.EE_WEBSITE_CRAWLER_MAX_LIMIT = originalMaxLimit;
      }
    }
  });

  it("requires a signed-in account session", async () => {
    await request(createApp())
      .post("/api/v1/ee/website-crawler/crawl")
      .send({ url: "https://example.com" })
      .expect(401);
  });

  it("validates crawl requests", async () => {
    const response = await request(createApp())
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "file:///etc/passwd" })
      .expect(400);

    expect(response.body.error.code).toBe("bad_request");
  });

  it("publishes configured provider results", async () => {
    const provider = createProvider();
    const response = await request(createApp({
      websiteCrawlerProvider: provider,
    }))
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(response.body).toEqual(expect.objectContaining({
      provider: "fake",
      runId: "run-1",
      requestedUrl: "https://example.com",
      accepted: 1,
      failed: 0,
    }));
  });

  it("rate limits crawl requests before calling the provider", async () => {
    const provider = createProvider();
    const abuseControlService = {
      enforce: vi.fn().mockRejectedValue({
        statusCode: 429,
        code: "rate_limited",
        message: "Too many requests",
      }),
    };

    await request(createApp({
      websiteCrawlerProvider: provider,
      abuseControlService,
    }))
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com", limit: 1 })
      .expect(429);

    expect(abuseControlService.enforce).toHaveBeenCalledWith({
      scope: "ee.website_crawler.crawl",
      subjectKey: "workspace-1:user:user-1",
      limit: 10,
      windowMs: 60000,
      blockMs: 60000,
    });
    expect(provider.crawl).not.toHaveBeenCalled();
  });

  it("passes requested workspace selection into the workspace resolver", async () => {
    const provider = createProvider();
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });

    await request(createApp({
      websiteCrawlerProvider: provider,
      documentIngestionService: { ingest },
    }))
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-2")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(ingest.mock.calls[0][0].workspaceId).toBe("workspace-2");
  });

  it("supports bearer token workspace authentication", async () => {
    const provider = createProvider();
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });

    await request(createApp({
      websiteCrawlerProvider: provider,
      documentIngestionService: { ingest },
    }))
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Authorization", "Bearer api-token")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(ingest.mock.calls[0][0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-token",
    }));
  });

  it("falls back to bearer token auth when a stale session cookie is present", async () => {
    const provider = createProvider();
    const ingest = vi.fn().mockResolvedValue({ documentId: "doc-1", status: "queued" });

    await request(createApp({
      websiteCrawlerProvider: provider,
      documentIngestionService: { ingest },
    }))
      .post("/api/v1/ee/website-crawler/crawl")
      .set("Cookie", "radioso_session=stale-session")
      .set("Authorization", "Bearer api-token")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(ingest.mock.calls[0][0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-token",
    }));
  });
});
