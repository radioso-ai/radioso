import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createUsageLimitRoutes } from "./usageLimitRoutes.js";

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ee/usage-limits", createUsageLimitRoutes(fakeDatabase));
  return app;
};

const fakeDatabase: UsageLimitDatabasePort = {
  async query() {
    return [];
  },
  async withTransaction(callback) {
    return callback(this);
  },
};

describe("usage limit admin routes", () => {
  afterEach(() => {
    delete process.env.EE_USAGE_ADMIN_TOKEN;
  });

  it("requires EE_USAGE_ADMIN_TOKEN to be configured", async () => {
    const response = await request(createApp())
      .get("/api/v1/ee/usage-limits/profiles")
      .expect(503);

    expect(response.body.error).toEqual(expect.objectContaining({
      code: "service_unavailable",
      details: { missingEnv: "EE_USAGE_ADMIN_TOKEN" },
    }));
  });

  it("rejects requests without the configured bearer token", async () => {
    process.env.EE_USAGE_ADMIN_TOKEN = "secret-admin-token";

    await request(createApp())
      .get("/api/v1/ee/usage-limits/profiles")
      .expect(401);
  });
});
