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

  it("sets a short public cache header", async () => {
    const response = await request(createApp())
      .get("/api/v1/plans")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("public, max-age=300");
  });
});
