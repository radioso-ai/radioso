import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWebsiteCrawlerRoutes } from "../../../src/modules/websiteCrawler/routes.js";
import type { WebsiteCrawlerProvider } from "../../../src/modules/websiteCrawler/provider.js";
import { unauthorized } from "../../../src/shared/domain/errors.js";

type RouteDependencies = Parameters<typeof createWebsiteCrawlerRoutes>[0];

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

const createApp = (dependencies: Partial<Record<keyof RouteDependencies, unknown>> = {}) => {
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
  app.use("/api/v1/document/crawl", createWebsiteCrawlerRoutes({
    env: {
      SESSION_COOKIE_NAME: "radioso_session",
    },
    authService: {
      async authenticateSession(token: string) {
        if (token !== "valid-session") {
          throw unauthorized();
        }
        return {
          accountId: "account-1",
          userId: "user-1",
          sessionId: "session-1",
        };
      },
      async authenticateApiToken(token: string) {
        if (token === "machine-api-token") {
          return {
            accountId: "account-1",
            workspaceId: "workspace-token",
            principal: {
              type: "service_account_credential" as const,
              serviceAccountId: "service-account-1",
              credentialId: "credential-1",
              role: "admin" as const,
              workspaceId: "workspace-token",
            },
          };
        }
        return {
          accountId: "account-1",
          workspaceId: "workspace-token",
          principal: {
            type: "workspace_api_token",
            role: "admin",
            tokenId: "token-id",
            workspaceId: "workspace-token",
          },
        };
      },
    },
    accountAccessService: {
      async requireActiveMembership() {},
      async requirePermission() {},
    },
    workspaceSessionService: {
      async resolve({ accountId, workspaceId }) {
        if (!workspaceId) {
          throw Object.assign(new Error("Workspace is required"), { statusCode: 400, code: "bad_request" });
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
    websiteCrawlJobService: {
      enqueue: vi.fn().mockResolvedValue({
        jobId: "11111111-1111-4111-8111-111111111111",
        sourceId: "22222222-2222-4222-8222-222222222222",
        requestedUrl: "https://example.com",
        status: "queued",
      }),
      listForWorkspace: vi.fn().mockResolvedValue([]),
      deleteJob: vi.fn().mockResolvedValue(undefined),
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

describe("website crawler routes", () => {
  it("returns unavailable when crawler provider is not configured", async () => {
    const response = await request(createApp())
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com" })
      .expect(503);

    expect(response.body.error).toEqual({
      code: "service_unavailable",
      message: "Website crawler is not configured",
    });
  });

  it("keeps crawler limit configuration failures scoped to crawler requests", async () => {
    const originalMaxLimit = process.env.WEBSITE_CRAWLER_MAX_LIMIT;
    process.env.WEBSITE_CRAWLER_MAX_LIMIT = "nope";
    try {
      const app = createApp({ websiteCrawlerProvider: createProvider() });
      const response = await request(app)
        .post("/api/v1/document/crawl")
        .set("Cookie", "radioso_session=valid-session")
        .set("x-workspace-id", "workspace-1")
        .send({ url: "https://example.com" })
        .expect(503);

      expect(response.body.error).toEqual({
        code: "service_unavailable",
        message: "WEBSITE_CRAWLER_MAX_LIMIT must be a positive integer",
        details: {
          invalidEnv: "WEBSITE_CRAWLER_MAX_LIMIT",
        },
      });
    } finally {
      if (originalMaxLimit === undefined) {
        delete process.env.WEBSITE_CRAWLER_MAX_LIMIT;
      } else {
        process.env.WEBSITE_CRAWLER_MAX_LIMIT = originalMaxLimit;
      }
    }
  });

  it("requires a signed-in account session", async () => {
    await request(createApp())
      .post("/api/v1/document/crawl")
      .send({ url: "https://example.com" })
      .expect(401);
  });

  it("validates crawl requests", async () => {
    const response = await request(createApp())
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "file:///etc/passwd" })
      .expect(400);

    expect(response.body.error.code).toBe("bad_request");
  });

  it("enqueues configured provider crawls", async () => {
    const provider = createProvider();
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      requestedUrl: "https://example.com",
      status: "queued",
    });
    const response = await request(createApp({
      websiteCrawlerProvider: provider,
      websiteCrawlJobService: { enqueue },
    }))
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(response.body).toEqual(expect.objectContaining({
      jobId: "11111111-1111-4111-8111-111111111111",
      requestedUrl: "https://example.com",
      status: "queued",
    }));
    expect(enqueue).toHaveBeenCalledWith({
      accountId: "account-1",
      workspaceId: "workspace-1",
      url: "https://example.com",
      limit: 1,
      policy: {
        includeUrlPatterns: [],
        excludeUrlPatterns: [],
        preserveContentLinks: true,
      },
    });
    expect(provider.crawl).not.toHaveBeenCalled();
  });

  it("validates and forwards crawl policy fields", async () => {
    const provider = createProvider();
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      requestedUrl: "https://example.com",
      status: "queued",
    });

    await request(createApp({
      websiteCrawlerProvider: provider,
      websiteCrawlJobService: { enqueue },
    }))
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({
        url: "https://example.com",
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/tag"],
        preserveContentLinks: false,
      })
      .expect(202);

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      policy: {
        includeUrlPatterns: ["/docs"],
        excludeUrlPatterns: ["/tag"],
        preserveContentLinks: false,
      },
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
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .send({ url: "https://example.com", limit: 1 })
      .expect(429);

    expect(abuseControlService.enforce).toHaveBeenCalledWith({
      scope: "document.crawl",
      subjectKey: "workspace-1:user:user-1",
      limit: 10,
      windowMs: 60000,
      blockMs: 60000,
    });
    expect(provider.crawl).not.toHaveBeenCalled();
  });

  it("keys machine credential crawl limits by stable credential id", async () => {
    const provider = createProvider();
    const enforce = vi.fn().mockRejectedValue({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many requests",
    });

    await request(createApp({ websiteCrawlerProvider: provider, abuseControlService: { enforce } }))
      .post("/api/v1/document/crawl")
      .set("Authorization", "Bearer machine-api-token")
      .send({ url: "https://example.com", limit: 1 })
      .expect(429);

    expect(enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "document.crawl",
      subjectKey: "workspace-token:api-credential:credential-1",
    }));
  });

  it("passes requested workspace selection into the workspace resolver", async () => {
    const provider = createProvider();
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: null,
      requestedUrl: "https://example.com",
      status: "queued",
    });

    await request(createApp({
      websiteCrawlerProvider: provider,
      websiteCrawlJobService: { enqueue },
    }))
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-2")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(enqueue.mock.calls[0][0].workspaceId).toBe("workspace-2");
  });

  it("supports bearer token workspace authentication", async () => {
    const provider = createProvider();
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: null,
      requestedUrl: "https://example.com",
      status: "queued",
    });

    await request(createApp({
      websiteCrawlerProvider: provider,
      websiteCrawlJobService: { enqueue },
    }))
      .post("/api/v1/document/crawl")
      .set("Authorization", "Bearer api-token")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(enqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-token",
    }));
  });

  it("returns recent crawl jobs scoped to the workspace", async () => {
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      requestedUrl: "https://example.com",
      status: "completed" as const,
      limit: 5,
      sourceId: "22222222-2222-4222-8222-222222222222",
      documentCount: 3,
      lastError: null,
      createdAt: "2026-05-11T10:00:00.000Z",
      updatedAt: "2026-05-11T10:05:00.000Z",
      completedAt: "2026-05-11T10:05:00.000Z",
    };
    const listForWorkspace = vi.fn().mockResolvedValue([job]);

    const response = await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace },
    }))
      .get("/api/v1/document/crawl/jobs")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(200);

    expect(response.body).toEqual({ jobs: [job] });
    expect(listForWorkspace).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      sinceMinutes: 30,
    }));
  });

  it("forwards crawl job list query parameters", async () => {
    const listForWorkspace = vi.fn().mockResolvedValue([]);

    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace },
    }))
      .get("/api/v1/document/crawl/jobs?status=processing&sinceMinutes=15&limit=10")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(200);

    expect(listForWorkspace).toHaveBeenCalledWith("workspace-1", {
      status: "processing",
      sinceMinutes: 15,
      limit: 10,
    });
  });

  it("keeps the recent window for source-scoped active status polling", async () => {
    const listForWorkspace = vi.fn().mockResolvedValue([]);
    const sourceId = "22222222-2222-4222-8222-222222222222";

    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace },
    }))
      .get(`/api/v1/document/crawl/jobs?sourceId=${sourceId}&status=processing&sinceMinutes=10`)
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(200);

    expect(listForWorkspace).toHaveBeenCalledWith("workspace-1", {
      status: "processing",
      sinceMinutes: 10,
      limit: undefined,
      sourceId,
    });
  });

  it("accepts paused as a crawl job list status", async () => {
    const listForWorkspace = vi.fn().mockResolvedValue([]);

    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace },
    }))
      .get("/api/v1/document/crawl/jobs?status=paused")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(200);

    expect(listForWorkspace).toHaveBeenCalledWith("workspace-1", expect.objectContaining({
      status: "paused",
      sinceMinutes: undefined,
    }));
  });

  it("rejects invalid crawl job list queries", async () => {
    const listForWorkspace = vi.fn().mockResolvedValue([]);

    const response = await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace },
    }))
      .get("/api/v1/document/crawl/jobs?status=bogus")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(400);

    expect(response.body.error.code).toBe("bad_request");
    expect(listForWorkspace).not.toHaveBeenCalled();
  });

  it("requires a signed-in account session for listing jobs", async () => {
    await request(createApp())
      .get("/api/v1/document/crawl/jobs")
      .expect(401);
  });

  it("deletes a terminal crawl job through the workspace-scoped DELETE endpoint", async () => {
    const deleteJob = vi.fn().mockResolvedValue(undefined);
    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob },
    }))
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(204);

    expect(deleteJob).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      jobId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("returns 409 when DELETE targets an in-flight job", async () => {
    const deleteJob = vi.fn().mockRejectedValue({
      statusCode: 409,
      code: "conflict",
      message: "Crawl job is still in progress and cannot be deleted",
    });

    const response = await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob },
    }))
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(409);

    expect(response.body.error.code).toBe("conflict");
  });

  it("returns 404 when DELETE targets a missing job", async () => {
    const deleteJob = vi.fn().mockRejectedValue({
      statusCode: 404,
      code: "not_found",
      message: "Crawl job not found",
    });

    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob },
    }))
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(404);
  });

  it("rejects DELETE without a session", async () => {
    await request(createApp())
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .expect(401);
  });

  it("rate-limits the GET /jobs endpoint via abuse control", async () => {
    const enforce = vi.fn().mockRejectedValue({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many requests",
    });
    const listForWorkspace = vi.fn().mockResolvedValue([]);

    await request(createApp({
      abuseControlService: { enforce },
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace, deleteJob: vi.fn() },
    }))
      .get("/api/v1/document/crawl/jobs")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(429);

    expect(enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "document.crawl.jobs.read",
    }));
    expect(listForWorkspace).not.toHaveBeenCalled();
  });

  it("uses the machine credential bucket when rate-limiting crawl job reads", async () => {
    const enforce = vi.fn().mockRejectedValue({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many requests",
    });

    await request(createApp({
      abuseControlService: { enforce },
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob: vi.fn() },
    }))
      .get("/api/v1/document/crawl/jobs")
      .set("Authorization", "Bearer machine-api-token")
      .expect(429);

    expect(enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "document.crawl.jobs.read",
      subjectKey: "workspace-token:api-credential:credential-1",
    }));
  });

  it("rate-limits the DELETE /jobs/:jobId endpoint via abuse control", async () => {
    const enforce = vi.fn().mockRejectedValue({
      statusCode: 429,
      code: "rate_limited",
      message: "Too many requests",
    });
    const deleteJob = vi.fn();

    await request(createApp({
      abuseControlService: { enforce },
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob },
    }))
      .delete("/api/v1/document/crawl/jobs/11111111-1111-4111-8111-111111111111")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(429);

    expect(enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "document.crawl.jobs.read",
    }));
    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("rejects DELETE with an invalid job id", async () => {
    const deleteJob = vi.fn();
    await request(createApp({
      websiteCrawlJobService: { enqueue: vi.fn(), listForWorkspace: vi.fn(), deleteJob },
    }))
      .delete("/api/v1/document/crawl/jobs/not-a-uuid")
      .set("Cookie", "radioso_session=valid-session")
      .set("x-workspace-id", "workspace-1")
      .expect(400);

    expect(deleteJob).not.toHaveBeenCalled();
  });

  it("falls back to bearer token auth when a stale session cookie is present", async () => {
    const provider = createProvider();
    const enqueue = vi.fn().mockResolvedValue({
      jobId: "11111111-1111-4111-8111-111111111111",
      sourceId: null,
      requestedUrl: "https://example.com",
      status: "queued",
    });

    await request(createApp({
      websiteCrawlerProvider: provider,
      websiteCrawlJobService: { enqueue },
    }))
      .post("/api/v1/document/crawl")
      .set("Cookie", "radioso_session=stale-session")
      .set("Authorization", "Bearer api-token")
      .send({ url: "https://example.com", limit: 1 })
      .expect(202);

    expect(enqueue.mock.calls[0][0]).toEqual(expect.objectContaining({
      accountId: "account-1",
      workspaceId: "workspace-token",
    }));
  });
});
