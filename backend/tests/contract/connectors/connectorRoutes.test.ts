import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

describe("connector management contract", () => {
  it("returns an empty registry when no connector capabilities are registered", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "connectors-list@example.com");

    const response = await request(app)
      .get("/api/v1/connectors")
      .set(adminSessionHeaders(session));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connectors: [],
    });
  });

  it("rejects unknown connector operations", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "connectors-unknown@example.com");

    const detail = await request(app)
      .get("/api/v1/connectors/removed")
      .set(adminSessionHeaders(session));
    const save = await request(app)
      .put("/api/v1/connectors/removed")
      .set(adminSessionHeaders(session))
      .send({ config: {} });
    const enable = await request(app)
      .post("/api/v1/connectors/removed/enable")
      .set(adminSessionHeaders(session));

    expect(detail.status).toBe(404);
    expect(save.status).toBe(404);
    expect(enable.status).toBe(404);
  });
});
