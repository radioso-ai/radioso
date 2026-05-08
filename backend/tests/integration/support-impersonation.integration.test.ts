import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

describe("support impersonation", () => {
  it("requires approval before support access can be used", async () => {
    const { app } = createTestApp();
    const customer = await issueTestSession(app, `customer-${Date.now()}@example.com`);
    const staff = await issueTestSession(app, "support@example.com");

    const blocked = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", staff.cookie)
      .set("X-Support-Impersonation-Id", "00000000-0000-0000-0000-000000000000")
      .send({ name: "Blocked" });
    expect(blocked.status).toBe(404);

    const approved = await request(app)
      .post("/api/v1/support/impersonations")
      .set("Cookie", staff.cookie)
      .send({ accountId: customer.accountId, reason: "Debug customer setup" });
    expect(approved.status).toBe(201);

    const beforeStart = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", staff.cookie)
      .set("X-Support-Impersonation-Id", approved.body.id)
      .send({ name: "Not Started" });
    expect(beforeStart.status).toBe(403);

    const started = await request(app)
      .post(`/api/v1/support/impersonations/${approved.body.id}/start`)
      .set("Cookie", staff.cookie);
    expect(started.status).toBe(200);
    expect(started.body.active).toBe(true);

    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", staff.cookie)
      .set("X-Support-Impersonation-Id", approved.body.id)
      .send({ name: "Support Workspace" });
    expect(created.status).toBe(201);

    const visible = await request(app).get("/api/v1/account/users").set("Cookie", customer.cookie);
    expect(visible.body.supportImpersonations).toEqual([
      expect.objectContaining({ id: approved.body.id, active: true }),
    ]);
  });
});
