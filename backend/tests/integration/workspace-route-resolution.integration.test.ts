import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

describe("workspace route resolution", () => {
  it("resolves an accessible workspace public route key for the signed-in user", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, `route-${Date.now()}@example.com`);
    const listResponse = await request(app).get("/api/v1/workspace").set("Cookie", session.cookie);
    const workspace = listResponse.body.workspaces[0] as { id: string; publicRouteKey: string; accountId: string; name: string };

    const response = await request(app)
      .get(`/api/v1/workspace/resolve/${workspace.publicRouteKey}`)
      .set("Cookie", session.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceKey: workspace.publicRouteKey,
      workspaceId: workspace.id,
      accountId: workspace.accountId,
      workspaceName: workspace.name,
      realtimeEnabled: false,
    });
  });

  it.each([
    { allowed: true },
    { allowed: false },
  ])("returns the browser-safe realtime flag when rollout allowed is $allowed", async ({ allowed }) => {
    const allows = vi.fn(() => allowed);
    const { app } = createTestApp({ realtimeRolloutPolicy: { allows } });
    const session = await issueTestSession(app, `route-policy-${allowed}-${Date.now()}@example.com`);
    const listResponse = await request(app).get("/api/v1/workspace").set("Cookie", session.cookie);
    const workspace = listResponse.body.workspaces[0] as { id: string; publicRouteKey: string; accountId: string };

    const response = await request(app)
      .get(`/api/v1/workspace/resolve/${workspace.publicRouteKey}`)
      .set("Cookie", session.cookie);

    expect(response.status).toBe(200);
    expect(response.body.realtimeEnabled).toBe(allowed);
    expect(response.body).not.toHaveProperty("realtimeRolloutPolicy");
    expect(allows).toHaveBeenCalledOnce();
    expect(allows).toHaveBeenCalledWith({ accountId: workspace.accountId });
  });

  it("returns 404 when the signed-in user cannot access the workspace key", async () => {
    const { app } = createTestApp();
    const ownerSession = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const outsiderSession = await issueTestSession(app, `outsider-${Date.now()}@example.com`);
    const listResponse = await request(app).get("/api/v1/workspace").set("Cookie", ownerSession.cookie);
    const workspace = listResponse.body.workspaces[0] as { publicRouteKey: string };

    const response = await request(app)
      .get(`/api/v1/workspace/resolve/${workspace.publicRouteKey}`)
      .set("Cookie", outsiderSession.cookie);

    expect(response.status).toBe(404);
  });
});
