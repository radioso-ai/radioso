import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import type { DataSubjectAccess, DataSubjectExportDocument } from "../../src/modules/privacy/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const ROUTES = ["lookup", "conversations", "export", "erase"] as const;
const IDENTITIES = [
  { kind: "web_visitor", key: randomUUID() },
  { kind: "email_address", key: "jane@example.com" },
];

const harness = async () => {
  const access = {
    lookup: vi.fn<DataSubjectAccess["lookup"]>(async () => [{
      identity: { kind: "email_address", key: "jane@example.com" },
      channel: "email",
      label: "jane@example.com",
      conversationCount: 2,
      firstSeenAt: new Date("2026-09-01T08:00:00.000Z"),
      lastSeenAt: null,
    }]),
    listConversations: vi.fn<DataSubjectAccess["listConversations"]>(async () => [{
      id: "conv-1",
      channel: "email",
      title: "Order 1182",
      startedAt: new Date("2026-09-01T08:00:00.000Z"),
      lastActivityAt: new Date("2026-09-02T08:00:00.000Z"),
      messageCount: 4,
    }]),
    export: vi.fn<DataSubjectAccess["export"]>(async ({ workspaceId, identities }): Promise<DataSubjectExportDocument> => ({
      format: "radioso.data_subject_export",
      formatVersion: 1,
      exportedAt: "2026-10-19T12:00:00.000Z",
      workspaceId,
      identities,
      sections: { conversations: [{ id: "conv-1", messages: [] }] },
    })),
    erase: vi.fn<DataSubjectAccess["erase"]>(async () => ({ visitorCount: 1, conversationCount: 3, messageCount: 9 })),
  };
  const { app, dependencies } = createTestApp({ dataSubjectAccess: access });
  const session = await issueTestSession(app, `data-subject-${randomUUID()}@example.com`);
  return { app, dependencies, access, session, headers: adminSessionHeaders(session) };
};

const post = (h: Awaited<ReturnType<typeof harness>>, route: string, body: unknown) =>
  request(h.app).post(`/api/v1/privacy/data-subjects/${route}`).set(h.headers).send(body as object);

describe("data subject request contract", () => {
  it("looks a subject up and answers each candidate identity with its channel and count", async () => {
    const h = await harness();

    const response = await post(h, "lookup", { query: "  jane@example.com " }).expect(200);

    expect(response.body).toEqual({
      identities: [{
        identity: { kind: "email_address", key: "jane@example.com" },
        channel: "email",
        label: "jane@example.com",
        conversationCount: 2,
        firstSeenAt: "2026-09-01T08:00:00.000Z",
        lastSeenAt: null,
      }],
    });
    expect(h.access.lookup).toHaveBeenCalledWith({
      workspaceId: h.session.workspaceId,
      query: "jane@example.com",
      actor: { accountId: h.session.accountId, userId: h.session.userId },
    });
  });

  it("lists, exports and erases over the confirmed identities", async () => {
    const h = await harness();

    const conversations = await post(h, "conversations", { identities: IDENTITIES }).expect(200);
    expect(conversations.body.conversations).toEqual([{
      id: "conv-1",
      channel: "email",
      title: "Order 1182",
      startedAt: "2026-09-01T08:00:00.000Z",
      lastActivityAt: "2026-09-02T08:00:00.000Z",
      messageCount: 4,
    }]);
    expect(h.access.listConversations).toHaveBeenCalledWith({ workspaceId: h.session.workspaceId, identities: IDENTITIES });

    const exported = await post(h, "export", { identities: IDENTITIES }).expect(200);
    expect(exported.body).toMatchObject({ format: "radioso.data_subject_export", formatVersion: 1, identities: IDENTITIES });
    expect(exported.headers["cache-control"]).toBe("no-store");

    const erased = await post(h, "erase", { identities: IDENTITIES }).expect(200);
    expect(erased.body).toEqual({ visitorCount: 1, conversationCount: 3, messageCount: 9 });
    expect(h.access.erase).toHaveBeenCalledWith({
      workspaceId: h.session.workspaceId,
      identities: IDENTITIES,
      actor: { accountId: h.session.accountId, userId: h.session.userId },
    });
  });

  it("refuses an empty query, an unknown identity kind, no identities or too many, before reading anything", async () => {
    const h = await harness();

    await post(h, "lookup", { query: "   " }).expect(400);
    await post(h, "lookup", { query: "jane@example.com", fuzzy: true }).expect(400);
    await post(h, "export", { identities: [{ kind: "phone_number", key: "+3725550000" }] }).expect(400);
    await post(h, "erase", { identities: [] }).expect(400);
    await post(h, "conversations", { identities: Array.from({ length: 51 }, () => ({ kind: "web_visitor", key: randomUUID() })) }).expect(400);
    expect(h.access.lookup).not.toHaveBeenCalled();
    expect(h.access.export).not.toHaveBeenCalled();
    expect(h.access.erase).not.toHaveBeenCalled();
    expect(h.access.listConversations).not.toHaveBeenCalled();
  });

  it("never echoes the query back in a refusal", async () => {
    const h = await harness();

    const response = await post(h, "lookup", { query: `${"x".repeat(321)}@example.com` }).expect(400);

    expect(JSON.stringify(response.body)).not.toContain("@example.com");
  });

  it("refuses a teammate without workspace.history.delete, even one who can read history", async () => {
    const h = await harness();
    vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
      if (permission === "workspace.history.delete") throw forbidden("You do not have permission to perform this action");
      return null;
    });

    await post(h, "lookup", { query: "jane@example.com" }).expect(403);
    for (const route of ROUTES.slice(1)) {
      await post(h, route, { identities: IDENTITIES }).expect(403);
    }
    await request(h.app).get("/api/v1/history/chat").set(h.headers).expect(200);
    expect(h.access.lookup).not.toHaveBeenCalled();
    expect(h.access.export).not.toHaveBeenCalled();
  });

  it("accepts a workspace credential, so a data subject request can be automated", async () => {
    const h = await harness();
    const { token, workspaceId } = await issueTestToken(h.app);

    await request(h.app)
      .post("/api/v1/privacy/data-subjects/export")
      .set("Authorization", `Bearer ${token}`)
      .send({ identities: IDENTITIES })
      .expect(200);

    expect(h.access.export).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    for (const route of ROUTES) {
      expect(apiPrincipalRoutePolicy[`POST /api/v1/privacy/data-subjects/${route}`]).toEqual({
        permission: "workspace.history.delete",
        allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
        sessionOnly: false,
      });
    }
  });
});
