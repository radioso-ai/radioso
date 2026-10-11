import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createMetricsRoutes } from "../../src/app/http/routes/metricsRoutes.js";
import { MetricsRegistry } from "../../src/shared/observability/metrics/metricsRegistry.js";

const TOKEN = "metrics-auth-token-000000";

const appServing = (metrics: MetricsRegistry) => {
  const app = express();
  app.use("/metrics", createMetricsRoutes(metrics, TOKEN));
  return app;
};

// A collector refreshes gauges whose source is state this process does not write itself, such as
// counts read from the shared database, so a scrape of any instance reports them.
describe("metrics scrape collectors", () => {
  it("refreshes collected gauges before a scrape renders them", async () => {
    const metrics = new MetricsRegistry();
    let reading = 0;
    metrics.registerCollector(async () => {
      reading += 1;
      metrics.setGauge("sampled_reading", { help: "A sampled reading", value: reading });
    });

    const response = await request(appServing(metrics)).get("/metrics").set("authorization", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain("radioso_sampled_reading 1");
  });

  it("still renders every other series when a collector fails", async () => {
    const metrics = new MetricsRegistry();
    metrics.incrementCounter("requests_total", { help: "Requests" });
    metrics.registerCollector(async () => {
      throw new Error("database unavailable");
    });

    const response = await request(appServing(metrics)).get("/metrics").set("authorization", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain("radioso_requests_total 1");
  });

  it("runs no collector for a scrape that fails authentication", async () => {
    const metrics = new MetricsRegistry();
    let collected = 0;
    metrics.registerCollector(async () => {
      collected += 1;
    });

    const response = await request(appServing(metrics)).get("/metrics");

    expect(response.status).toBe(401);
    expect(collected).toBe(0);
  });
});
