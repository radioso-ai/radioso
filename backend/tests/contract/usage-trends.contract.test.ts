import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createUsageTrendsRoutes } from "../../src/modules/reporting/routes.js";
import type { UsageTrendsServicePort } from "../../src/modules/reporting/contracts/index.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const trendsService = (overrides: Partial<UsageTrendsServicePort> = {}): UsageTrendsServicePort => ({
  getUsageTrends: vi.fn().mockResolvedValue({
    granularity: "day",
    from: "2026-06-01",
    to: "2026-06-02",
    filters: { workspaceId: null, agentId: null },
    buckets: [
      {
        periodStart: "2026-06-01T00:00:00.000Z",
        periodEnd: "2026-06-02T00:00:00.000Z",
        conversationsCreated: 0,
        messages: { total: 0, user: 0, assistant: 0 },
        tokens: { input: 0, output: 0, total: 0 },
      },
      {
        periodStart: "2026-06-02T00:00:00.000Z",
        periodEnd: "2026-06-03T00:00:00.000Z",
        conversationsCreated: 1,
        messages: { total: 2, user: 1, assistant: 1 },
        tokens: { input: 10, output: 20, total: 30 },
      },
    ],
  }),
  ...overrides,
});

describe("usage trends contract", () => {
  it("returns the account usage trends response shape for an active member session", async () => {
    const service = trendsService();
    const { app } = createTestApp({
      applicationRouteMounts: [{
        path: "/api/v1/account",
        createRouter: (dependencies) => createUsageTrendsRoutes(dependencies, service),
      }],
    });
    const session = await issueTestSession(app, "usage-trends-member@example.com");

    const response = await request(app)
      .get("/api/v1/account/usage-trends")
      .query({ from: "2026-06-01", to: "2026-06-02", granularity: "day" })
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      granularity: "day",
      from: "2026-06-01",
      to: "2026-06-02",
      filters: { workspaceId: null, agentId: null },
      buckets: expect.arrayContaining([
        expect.objectContaining({
          periodStart: "2026-06-02T00:00:00.000Z",
          periodEnd: "2026-06-03T00:00:00.000Z",
          conversationsCreated: 1,
          messages: { total: 2, user: 1, assistant: 1 },
          tokens: { input: 10, output: 20, total: 30 },
        }),
      ]),
    });
    expect(service.getUsageTrends).toHaveBeenCalledWith({
      accountId: session.accountId,
      userId: session.userId,
      from: "2026-06-01",
      to: "2026-06-02",
      granularity: "day",
      workspaceId: undefined,
      agentId: undefined,
    });
  });

  it("rejects requests without an active session", async () => {
    const service = trendsService();
    const { app } = createTestApp({
      applicationRouteMounts: [{
        path: "/api/v1/account",
        createRouter: (dependencies) => createUsageTrendsRoutes(dependencies, service),
      }],
    });

    const response = await request(app)
      .get("/api/v1/account/usage-trends")
      .query({ from: "2026-06-01", to: "2026-06-02", granularity: "day" });

    expect(response.status).toBe(401);
    expect(service.getUsageTrends).not.toHaveBeenCalled();
  });

  it("returns the project error shape for invalid query parameters", async () => {
    const service = trendsService();
    const { app } = createTestApp({
      applicationRouteMounts: [{
        path: "/api/v1/account",
        createRouter: (dependencies) => createUsageTrendsRoutes(dependencies, service),
      }],
    });
    const session = await issueTestSession(app, "usage-trends-invalid@example.com");

    const response = await request(app)
      .get("/api/v1/account/usage-trends")
      .query({ from: "2026-06-01", to: "2026-06-02", granularity: "hour" })
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "bad_request",
      },
    });
    expect(service.getUsageTrends).not.toHaveBeenCalled();
  });
});
