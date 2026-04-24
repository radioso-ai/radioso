import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

const getWorkspaces = async (app: ReturnType<typeof createTestApp>["app"], cookie: string) => {
  const res = await request(app).get("/api/v1/workspace").set("Cookie", cookie);
  return res.body.workspaces as Array<{ id: string; name: string }>;
};

describe("workspace management", () => {
  describe("PATCH /api/v1/workspace/:workspaceId (rename)", () => {
    it("renames a workspace successfully", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);
      const workspaces = await getWorkspaces(app, cookie);
      const workspace = workspaces[0];

      const res = await request(app)
        .patch(`/api/v1/workspace/${workspace.id}`)
        .set("Cookie", cookie)
        .send({ name: "Renamed Workspace" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Renamed Workspace");
      expect(res.body.id).toBe(workspace.id);
      expect(res.body.publicRouteKey).toBeDefined();
    });

    it("trims whitespace from workspace name", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);
      const workspaces = await getWorkspaces(app, cookie);

      const res = await request(app)
        .patch(`/api/v1/workspace/${workspaces[0].id}`)
        .set("Cookie", cookie)
        .send({ name: "  Trimmed Name  " });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Trimmed Name");
      expect(res.body.publicRouteKey).toBeDefined();
    });

    it("rejects empty workspace name", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);
      const workspaces = await getWorkspaces(app, cookie);

      const res = await request(app)
        .patch(`/api/v1/workspace/${workspaces[0].id}`)
        .set("Cookie", cookie)
        .send({ name: "" });

      expect(res.status).toBe(400);
    });

    it("rejects workspace name over 100 characters", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);
      const workspaces = await getWorkspaces(app, cookie);

      const res = await request(app)
        .patch(`/api/v1/workspace/${workspaces[0].id}`)
        .set("Cookie", cookie)
        .send({ name: "A".repeat(101) });

      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent workspace", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);

      const res = await request(app)
        .patch("/api/v1/workspace/00000000-0000-0000-0000-000000000000")
        .set("Cookie", cookie)
        .send({ name: "New Name" });

      expect(res.status).toBe(404);
    });

    it("returns 404 for workspace not owned by account", async () => {
      const { app } = createTestApp();
      const { cookie: cookie1 } = await issueTestSession(app, `ws-test-a-${Date.now()}@example.com`);
      const { cookie: cookie2 } = await issueTestSession(app, `ws-test-b-${Date.now()}@example.com`);
      const workspaces1 = await getWorkspaces(app, cookie1);

      const res = await request(app)
        .patch(`/api/v1/workspace/${workspaces1[0].id}`)
        .set("Cookie", cookie2)
        .send({ name: "Hijacked" });

      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/workspace/:workspaceId", () => {
    it("deletes a workspace successfully when multiple exist", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);

      // Create a second workspace
      await request(app)
        .post("/api/v1/workspace")
        .set("Cookie", cookie)
        .send({ name: "Second Workspace" });

      const workspaces = await getWorkspaces(app, cookie);
      expect(workspaces).toHaveLength(2);

      const res = await request(app)
        .delete(`/api/v1/workspace/${workspaces[0].id}`)
        .set("Cookie", cookie);

      expect(res.status).toBe(204);

      const remaining = await getWorkspaces(app, cookie);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(workspaces[1].id);
    });

    it("rejects deletion of the last workspace", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);
      const workspaces = await getWorkspaces(app, cookie);
      expect(workspaces).toHaveLength(1);

      const res = await request(app)
        .delete(`/api/v1/workspace/${workspaces[0].id}`)
        .set("Cookie", cookie);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("last workspace");
    });

    it("returns 404 for non-existent workspace", async () => {
      const { app } = createTestApp();
      const { cookie } = await issueTestSession(app, `ws-test-${Date.now()}@example.com`);

      const res = await request(app)
        .delete("/api/v1/workspace/00000000-0000-0000-0000-000000000000")
        .set("Cookie", cookie);

      expect(res.status).toBe(404);
    });

    it("returns 404 for workspace not owned by account", async () => {
      const { app } = createTestApp();
      const { cookie: cookie1 } = await issueTestSession(app, `ws-test-a-${Date.now()}@example.com`);
      const { cookie: cookie2 } = await issueTestSession(app, `ws-test-b-${Date.now()}@example.com`);
      const workspaces1 = await getWorkspaces(app, cookie1);

      // Create second workspace for user1 so they have 2
      await request(app)
        .post("/api/v1/workspace")
        .set("Cookie", cookie1)
        .send({ name: "Extra" });

      const res = await request(app)
        .delete(`/api/v1/workspace/${workspaces1[0].id}`)
        .set("Cookie", cookie2);

      expect(res.status).toBe(404);
    });
  });
});
