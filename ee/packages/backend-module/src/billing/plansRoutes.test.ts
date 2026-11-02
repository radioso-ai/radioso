import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { createPlansRoutes } from "./plansRoutes.js";

const createApp = () => {
  const app = express();
  app.use("/api/v1/plans", createPlansRoutes());
  return app;
};

describe("GET /api/v1/plans", () => {
  it("returns the plan catalog with no auth header", async () => {
    const response = await request(createApp())
      .get("/api/v1/plans")
      .expect(200);

    expect(response.body).toEqual(PLAN_CATALOG);
  });

  // The route is public and CDN-cacheable, so a field added to the catalog is published by
  // default. Pinning the keys turns that into a decision: staff-only numbers such as model list
  // prices and the spend flag belong in MODEL_SPEND_ESTIMATE, which this route never serves.
  it("publishes exactly the public catalog fields, at the top level and on every plan", async () => {
    const response = await request(createApp())
      .get("/api/v1/plans")
      .expect(200);

    expect(Object.keys(response.body).sort()).toEqual([
      "autoTopUp",
      "conversationGraceShare",
      "countsAs",
      "currency",
      "defaultPlanId",
      "managedModels",
      "plans",
      "repliesPerConversation",
      "selfServeCeilingPlanId",
      "taxBehavior",
      "topUp",
    ]);
    for (const plan of response.body.plans as Record<string, unknown>[]) {
      expect(Object.keys(plan).sort()).toEqual([
        "annualPriceCents",
        "dailyNotificationEmails",
        "documents",
        "id",
        "interval",
        "models",
        "monthlyConversations",
        "monthlyIndexedBytes",
        "name",
        "priceCents",
        "storedBytes",
        "stripe",
        "support",
        "topUps",
      ]);
    }
  });

  it("sets a short public cache header", async () => {
    const response = await request(createApp())
      .get("/api/v1/plans")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });
});
