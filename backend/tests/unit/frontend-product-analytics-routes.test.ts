import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";

describe("frontend product analytics routes", () => {
  it("captures frontend product events through the generic product analytics service", async () => {
    const { app, repositories } = createTestApp();

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        properties: {
          path: "/w/acme/chat",
        },
        source: "frontend",
      })
      .expect(202);

    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "product.analytics",
      eventStatus: "success",
      metadata: {
        analytics: expect.objectContaining({
          eventName: "frontend.page_view",
          properties: expect.objectContaining({
            path: "/w/[workspaceKey]/chat",
          }),
          source: "frontend",
        }),
      },
    }));
  });

  it("normalizes page view paths before persistence", async () => {
    const { app, repositories } = createTestApp();

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        properties: {
          path: "/reset-password?token=secret-token",
        },
        source: "frontend",
      })
      .expect(202);

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        properties: {
          path: "/invite/super-secret-token",
        },
        source: "frontend",
      })
      .expect(202);

    const pageViews = repositories.auditEventRepository.items
      .filter((event) => event.eventType === "product.analytics")
      .map((event) => event.metadata?.analytics);

    expect(pageViews).toEqual([
      expect.objectContaining({
        properties: {
          path: "/reset-password",
        },
      }),
      expect.objectContaining({
        properties: {
          path: "/invite/[token]",
        },
      }),
    ]);
  });

  it("accepts frontend beacon event envelopes without trusting client timestamps", async () => {
    const { app, repositories } = createTestApp();

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        timestamp: "2026-04-22T10:00:00.000Z",
        properties: {
          path: "/w/acme/chat",
        },
        source: "frontend",
      })
      .expect(202);

    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "product.analytics",
      eventStatus: "success",
      metadata: {
        analytics: expect.objectContaining({
          eventName: "frontend.page_view",
          properties: {
            path: "/w/[workspaceKey]/chat",
          },
          source: "frontend",
          timestamp: expect.not.stringMatching("2026-04-22T10:00:00.000Z"),
        }),
      },
    }));
  });

  it("rejects unsupported frontend analytics event names", async () => {
    const { app } = createTestApp();

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "posthog.capture",
        source: "frontend",
      })
      .expect(400);
  });

  it("rejects forged tenant identity and extra page-view properties", async () => {
    const { app } = createTestApp();

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        workspaceId: "workspace-1",
        accountId: "account-1",
        actorType: "operator",
        properties: {
          path: "/w/acme/chat",
        },
        source: "frontend",
      })
      .expect(400);

    await request(app)
      .post("/api/v1/observability/product-analytics")
      .send({
        eventName: "frontend.page_view",
        properties: {
          path: "/chat/secret",
          url: "https://radioso.app/chat/secret?token=secret",
        },
        source: "frontend",
      })
      .expect(400);
  });
});
