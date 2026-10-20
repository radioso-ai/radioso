import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { forbidden } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const harness = async () => {
  const { app, dependencies } = createTestApp();
  const session = await issueTestSession(app, `settings-privacy-${randomUUID()}@example.com`);
  return { app, dependencies, session, headers: adminSessionHeaders(session) };
};

/** Denies the one permission, as a role without it would. */
const denyPermission = (h: Awaited<ReturnType<typeof harness>>, denied: string) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permission === denied) throw forbidden("You do not have permission to perform this action");
    return null;
  });

describe("privacy settings contract", () => {
  it("keeps conversations until they are deleted when no window was set", async () => {
    const h = await harness();

    const response = await request(h.app).get("/api/v1/settings/privacy").set(h.headers);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversationRetentionDays: null });
  });

  it("sets a window, reads it back, and audits the change from the old window to the new one", async () => {
    const h = await harness();
    const record = vi.spyOn(h.dependencies.auditService, "record");

    const saved = await request(h.app).put("/api/v1/settings/privacy").set(h.headers).send({ conversationRetentionDays: 365 });
    const read = await request(h.app).get("/api/v1/settings/privacy").set(h.headers);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ conversationRetentionDays: 365 });
    expect(read.body).toEqual({ conversationRetentionDays: 365 });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: h.session.workspaceId,
      eventType: "workspace.privacy_settings.updated",
      metadata: { actorUserId: h.session.userId, conversationRetentionDays: { from: null, to: 365 } },
    }));
  });

  it("turns retention off with null", async () => {
    const h = await harness();
    await request(h.app).put("/api/v1/settings/privacy").set(h.headers).send({ conversationRetentionDays: 90 }).expect(200);

    const response = await request(h.app).put("/api/v1/settings/privacy").set(h.headers).send({ conversationRetentionDays: null });

    expect(response.body).toEqual({ conversationRetentionDays: null });
  });

  it.each([
    [{ conversationRetentionDays: 6 }],
    [{ conversationRetentionDays: 3651 }],
    [{ conversationRetentionDays: 30.5 }],
    [{ conversationRetentionDays: "30" }],
    [{}],
    [{ conversationRetentionDays: 30, extra: true }],
  ])("refuses %j", async (body) => {
    const h = await harness();

    await request(h.app).put("/api/v1/settings/privacy").set(h.headers).send(body).expect(400);
    expect((await request(h.app).get("/api/v1/settings/privacy").set(h.headers)).body).toEqual({ conversationRetentionDays: null });
  });

  it("refuses a teammate who manages settings but cannot delete history", async () => {
    const h = await harness();
    denyPermission(h, "workspace.history.delete");

    await request(h.app).put("/api/v1/settings/privacy").set(h.headers).send({ conversationRetentionDays: 30 }).expect(403);
    await request(h.app).get("/api/v1/settings/privacy").set(h.headers).expect(200);
  });
});
