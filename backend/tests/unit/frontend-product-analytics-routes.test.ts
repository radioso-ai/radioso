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

    // The route is intentionally strict: browser-originated observability
    // payloads cannot claim tenant or actor identity.
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

describe("frontend error reporting routes", () => {
  it("captures frontend errors through the generic error reporting service", async () => {
    const { app, repositories } = createTestApp();

    await request(app)
      .post("/api/v1/observability/frontend-errors")
      .send({
        errorType: "frontend.react.unhandled",
        message: "Dashboard render failed",
        errorClass: "TypeError",
        stack: "TypeError: Dashboard render failed\n    at Dashboard (https://app.example/w/acme/chat?token=secret:1:2)",
        componentStack: "\n    at Dashboard\n    at App",
        path: "/w/acme/chat?token=secret",
        source: "frontend",
      })
      .expect(202, {
        accepted: true,
        recorded: true,
      });

    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "error.recorded",
      eventStatus: "failure",
      metadata: {
        error: expect.objectContaining({
          errorType: "frontend.react.unhandled",
          message: "Dashboard render failed",
          errorClass: "TypeError",
          requestContext: {
            method: "CLIENT",
            route: "/w/[workspaceKey]/chat",
          },
          metadata: expect.objectContaining({
            componentStack: "\n    at Dashboard\n    at App",
            source: "frontend",
            userAgent: expect.any(String),
          }),
          stack: expect.not.stringContaining("secret"),
        }),
      },
    }));
  });

  it("truncates oversized frontend error payload fields instead of rejecting the report", async () => {
    const { app, repositories } = createTestApp();

    await request(app)
      .post("/api/v1/observability/frontend-errors")
      .send({
        errorType: "frontend.runtime.unhandled",
        message: "m".repeat(2058),
        errorClass: "TypeError",
        stack: "s".repeat(16_394),
        componentStack: "c".repeat(8202),
        path: "/w/acme/chat",
        source: "frontend",
      })
      .expect(202);

    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "error.recorded",
      metadata: {
        error: expect.objectContaining({
          message: "m".repeat(2048),
          stack: "s".repeat(16_384),
          metadata: expect.objectContaining({
            componentStack: "c".repeat(8192),
          }),
        }),
      },
    }));
  });

  it("rejects forged identity and unsupported frontend error types", async () => {
    const { app } = createTestApp();

    await request(app)
      .post("/api/v1/observability/frontend-errors")
      .send({
        errorType: "posthog.capture",
        message: "boom",
        path: "/w/acme/chat",
        source: "frontend",
      })
      .expect(400);

    await request(app)
      .post("/api/v1/observability/frontend-errors")
      .send({
        errorType: "frontend.runtime.unhandled",
        message: "boom",
        workspaceId: "workspace-1",
        path: "/w/acme/chat",
        source: "frontend",
      })
      .expect(400);
  });
});
