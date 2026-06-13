import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ApplicationRouteMount } from "../../src/app/composition/applicationModule.js";
import { createTestApp } from "../support/testApp.js";

const clientIpEchoMount: ApplicationRouteMount = {
  path: "/__test/trust-proxy",
  createRouter() {
    const router = Router();
    router.get("/client-ip", (req, res) => {
      res.status(200).json({ ip: req.ip });
    });
    return router;
  },
};

describe("trust proxy configuration", () => {
  it("keeps the secure default by ignoring X-Forwarded-For for req.ip", async () => {
    const { app } = createTestApp({
      applicationRouteMounts: [clientIpEchoMount],
    });

    const response = await request(app)
      .get("/__test/trust-proxy/client-ip")
      .set("X-Forwarded-For", "203.0.113.7")
      .expect(200);

    expect(response.body.ip).not.toBe("203.0.113.7");
  });

  it("uses X-Forwarded-For for req.ip when a trusted proxy hop is configured", async () => {
    const { app } = createTestApp({
      applicationRouteMounts: [clientIpEchoMount],
      envOverrides: { TRUST_PROXY_HOPS: 1 },
    });

    const response = await request(app)
      .get("/__test/trust-proxy/client-ip")
      .set("X-Forwarded-For", "203.0.113.7")
      .expect(200);

    expect(response.body.ip).toBe("203.0.113.7");
  });
});
