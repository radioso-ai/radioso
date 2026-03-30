import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

describe("auth session integration", () => {
  it("supports switching between multiple workspaces through the session cookie and explicit workspace selection", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "session-multi@example.com");

    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", session.cookie)
      .send({ name: "Research" });

    expect(created.status).toBe(201);

    const defaultSettings = await request(app)
      .get("/api/v1/settings/general")
      .set(adminSessionHeaders(session));
    const secondWorkspaceSettings = await request(app)
      .get("/api/v1/settings/general")
      .set({
        Cookie: session.cookie,
        "X-Workspace-Id": created.body.id,
      });

    expect(defaultSettings.status).toBe(200);
    expect(secondWorkspaceSettings.status).toBe(200);
    expect(secondWorkspaceSettings.body.anonymousChatEnabled).toBe(false);
  });
});
