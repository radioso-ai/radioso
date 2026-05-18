import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("agent deletion", () => {
  it("deletes a non-default agent for an owner", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-delete-owner@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Side agent" })
      .expect(201);

    await request(app)
      .delete(`/api/v1/agents/${sideAgent.body.id}`)
      .set(adminSessionHeaders(session))
      .expect(204);

    const after = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(after.body.agents).toHaveLength(1);
    expect(after.body.agents[0].id).toBe(defaultAgentId);
  });

  it("rejects deletion of the last remaining agent", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-delete-last@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    await request(app)
      .delete(`/api/v1/agents/${defaultAgentId}`)
      .set(adminSessionHeaders(session))
      .expect(400);
  });

  it("keeps the remaining agent after deleting the workspace default", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "agent-delete-default@example.com");

    const list = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    const replacement = await request(app)
      .post("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .send({ name: "Replacement" })
      .expect(201);

    await request(app)
      .delete(`/api/v1/agents/${defaultAgentId}`)
      .set(adminSessionHeaders(session))
      .expect(204);

    const after = await request(app)
      .get("/api/v1/agents")
      .set(adminSessionHeaders(session))
      .expect(200);
    expect(after.body.agents).toHaveLength(1);
    expect(after.body.agents[0].id).toBe(replacement.body.id);

    await request(app)
      .get(`/api/v1/agents/${defaultAgentId}`)
      .set(adminSessionHeaders(session))
      .expect(404);
  });
});

describe("organization deletion", () => {
  it("deletes the organization when the owner requests it and clears the session cookie", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "org-delete-owner@example.com");

    const response = await request(app)
      .delete("/api/v1/account")
      .set("Cookie", session.cookie)
      .expect(204);

    const setCookie = response.headers["set-cookie"];
    const cookieValue = Array.isArray(setCookie) ? setCookie.join(";") : (setCookie ?? "");
    expect(cookieValue).toContain("Max-Age=0");
  });
});
