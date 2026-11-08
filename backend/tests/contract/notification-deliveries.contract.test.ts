import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { operationPermissionRequirements } from "../../src/app/http/openapi/operationPermissionRequirements.js";
import {
  NotificationDeliveryReader,
  type NotificationDeliveryRecord,
  type NotificationDeliveryStore,
} from "../../src/modules/operatorNotifications/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

/** A store holding rows per workspace, newest first as the repository returns them. */
const inMemoryStore = () => {
  const rows: Array<NotificationDeliveryRecord & { workspaceId: string }> = [];
  const store: Pick<NotificationDeliveryStore, "list"> = {
    list: async (workspaceId, query) => rows
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => query.agentId === undefined || row.agentId === query.agentId)
      .filter((row) => query.outcome === undefined || row.outcome === query.outcome)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .filter((row) => query.after === null
        || row.createdAt < query.after.createdAt
        || (row.createdAt.getTime() === query.after.createdAt.getTime() && row.id < query.after.id))
      .slice(0, query.limit)
      .map(({ workspaceId: _workspaceId, ...record }) => record),
  };
  let clock = Date.UTC(2026, 10, 7, 9, 0, 0);
  const seed = (workspaceId: string, overrides: Partial<NotificationDeliveryRecord> = {}): NotificationDeliveryRecord => {
    clock += 1_000;
    const record: NotificationDeliveryRecord = {
      id: randomUUID(),
      agentId: AGENT,
      conversationId: randomUUID(),
      kind: "contact_request",
      recipientEmail: "front-desk@example.com",
      outcome: "sent",
      createdAt: new Date(clock),
      updatedAt: new Date(clock),
      ...overrides,
    };
    rows.push({ ...record, workspaceId });
    return record;
  };
  return { store, seed };
};

const harness = async () => {
  const { store, seed } = inMemoryStore();
  const { app, dependencies } = createTestApp({ notificationDeliveries: new NotificationDeliveryReader(store) });
  const session = await issueTestSession(app, `notification-deliveries-${randomUUID()}@example.com`);
  return { app, dependencies, seed, owner: { ...session, headers: adminSessionHeaders(session) } };
};

describe("notification deliveries contract", () => {
  it("lists the workspace's deliveries newest first, page by page, with the address and what happened to it", async () => {
    const h = await harness();
    const oldest = h.seed(h.owner.workspaceId, { outcome: "failed" });
    const middle = h.seed(h.owner.workspaceId, { outcome: "skipped_unconfirmed", recipientEmail: "waiting@example.com", kind: "handoff" });
    const newest = h.seed(h.owner.workspaceId);
    h.seed(randomUUID());

    const first = await request(h.app).get("/api/v1/notification-deliveries?limit=2").set(h.owner.headers).expect(200);

    expect(first.body.items).toEqual([
      {
        id: newest.id,
        agentId: AGENT,
        conversationId: newest.conversationId,
        kind: "contact_request",
        recipientEmail: "front-desk@example.com",
        outcome: "sent",
        createdAt: newest.createdAt.toISOString(),
        updatedAt: newest.updatedAt.toISOString(),
      },
      expect.objectContaining({ id: middle.id, kind: "handoff", outcome: "skipped_unconfirmed", recipientEmail: "waiting@example.com" }),
    ]);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(h.app)
      .get(`/api/v1/notification-deliveries?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(h.owner.headers)
      .expect(200);
    expect(second.body).toEqual({ items: [expect.objectContaining({ id: oldest.id, outcome: "failed" })], nextCursor: null });
  });

  it("narrows to one agent and to one outcome, and shows no request id", async () => {
    const h = await harness();
    h.seed(h.owner.workspaceId, { outcome: "skipped_revoked" });
    const theirs = h.seed(h.owner.workspaceId, { agentId: OTHER_AGENT, outcome: "skipped_revoked" });
    h.seed(h.owner.workspaceId, { agentId: OTHER_AGENT, outcome: "sent" });

    const scoped = await request(h.app)
      .get(`/api/v1/notification-deliveries?agentId=${OTHER_AGENT}&outcome=skipped_revoked`)
      .set(h.owner.headers)
      .expect(200);

    expect(scoped.body.items.map((item: { id: string }) => item.id)).toEqual([theirs.id]);
    expect(Object.keys(scoped.body.items[0]).sort()).toEqual([
      "agentId", "conversationId", "createdAt", "id", "kind", "outcome", "recipientEmail", "updatedAt",
    ]);
  });

  it("returns an empty page for a workspace with no notices", async () => {
    const h = await harness();

    const empty = await request(h.app).get("/api/v1/notification-deliveries").set(h.owner.headers).expect(200);

    expect(empty.body).toEqual({ items: [], nextCursor: null });
  });

  it("refuses an invalid query", async () => {
    const h = await harness();

    await request(h.app).get("/api/v1/notification-deliveries?limit=101").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/notification-deliveries?limit=0").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/notification-deliveries?outcome=delivered").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/notification-deliveries?agentId=not-a-uuid").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/notification-deliveries?cursor=not-a-cursor").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/notification-deliveries?workspaceId=other").set(h.owner.headers).expect(400);
  });

  describe("governance", () => {
    it("declares the route session-only under the agent read permission", () => {
      expect(apiPrincipalRoutePolicy["GET /api/v1/notification-deliveries"]).toEqual({
        permission: "workspace.agents.read",
        allowedPrincipalKinds: ["session_user"],
        sessionOnly: true,
      });
      expect(operationPermissionRequirements.listNotificationDeliveries).toEqual(["workspace.agents.read"]);
    });

    it("refuses a machine credential, because the addresses are personal data", async () => {
      const h = await harness();
      h.seed(h.owner.workspaceId);
      const { token } = await issueTestToken(h.app);

      await request(h.app).get("/api/v1/notification-deliveries").set({ Authorization: `Bearer ${token}` }).expect(401);
    });

    it("refuses a request with no credential", async () => {
      const h = await harness();

      await request(h.app).get("/api/v1/notification-deliveries").expect(401);
    });

    it("refuses a teammate without the agent read permission", async () => {
      const h = await harness();
      h.seed(h.owner.workspaceId);
      vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
        if (permission === "workspace.history.read") return null;
        throw forbidden("You do not have permission to perform this action");
      });

      await request(h.app).get("/api/v1/notification-deliveries").set(h.owner.headers).expect(403);
    });
  });
});
