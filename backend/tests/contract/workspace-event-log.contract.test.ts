import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { encodeLogCursor } from "../../src/modules/workspaceEventLog/cursor.js";
import { WorkspaceEventLog } from "../../src/modules/workspaceEventLog/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { workspaceEventDataSchema, type WorkspaceEventType } from "../../src/shared/domain/workspaceEventLog.js";
import { InMemoryWorkspaceEventLogStore } from "../support/inMemoryWorkspaceEventLog.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const harness = async () => {
  const store = new InMemoryWorkspaceEventLogStore();
  const { app, dependencies } = createTestApp({ workspaceEventLog: new WorkspaceEventLog({ store }) });
  const session = await issueTestSession(app, `workspace-events-${randomUUID()}@example.com`);
  return { app, dependencies, store, owner: { ...session, headers: adminSessionHeaders(session) } };
};

/** What a served event's `data` must parse as, per type, from the published contract. */
const servedEventSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  version: z.literal(1),
  occurredAt: z.string().datetime(),
  workspaceId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
});

describe("workspace events contract", () => {
  it("starts at the newest events and pages forward with the cursor it returns", async () => {
    const h = await harness();
    const conversationId = randomUUID();
    const started = h.store.append({ workspaceId: h.owner.workspaceId, type: "conversation.started", conversationId });
    h.store.append({ workspaceId: randomUUID(), type: "conversation.started" });

    const first = await request(h.app).get("/api/v1/workspace/events").set(h.owner.headers).expect(200);
    expect(first.body).toEqual({
      events: [{
        id: started.id,
        type: "conversation.started",
        version: 1,
        occurredAt: started.occurredAt.toISOString(),
        workspaceId: h.owner.workspaceId,
        data: { conversationId, agentId: null, channel: "web", callerKind: "human", visitorId: null },
      }],
      nextCursor: expect.any(String),
      hasMore: false,
    });

    const routine = h.store.append({
      workspaceId: h.owner.workspaceId,
      type: "routine.completed",
      conversationId,
      data: { routineId: "booking", executionId: null, outcome: "complete", values: { phone: "[redacted]" }, sensitiveSlotKeys: ["phone"] },
    });
    const next = await request(h.app)
      .get(`/api/v1/workspace/events?after=${encodeURIComponent(first.body.nextCursor)}`)
      .set(h.owner.headers)
      .expect(200);
    expect(next.body.events.map((event: { id: string }) => event.id)).toEqual([routine.id]);
    for (const event of [...first.body.events, ...next.body.events]) {
      const served = servedEventSchema.parse(event);
      expect(() => workspaceEventDataSchema(served.type as WorkspaceEventType).strict().parse(served.data)).not.toThrow();
    }
  });

  it("serves a document event with the document it names and nothing about a conversation", async () => {
    const h = await harness();
    const documentId = randomUUID();
    const sourceId = randomUUID();
    const uploadsSourceId = randomUUID();
    const processed = h.store.append({
      workspaceId: h.owner.workspaceId,
      type: "document.processed",
      data: { documentId, revision: 3, title: "Opening hours", contentKind: "inline_text", sourceKind: "website", sourceId },
    });
    const failed = h.store.append({
      workspaceId: h.owner.workspaceId,
      type: "document.failed",
      data: { documentId, revision: 4, title: "Opening hours", contentKind: "uploaded_file", sourceKind: "upload", sourceId: uploadsSourceId, failureCode: "provider_misconfigured" },
    });

    const page = await request(h.app).get("/api/v1/workspace/events?types=document.processed,document.failed").set(h.owner.headers).expect(200);

    expect(page.body.events).toEqual([
      {
        id: processed.id,
        type: "document.processed",
        version: 1,
        occurredAt: processed.occurredAt.toISOString(),
        workspaceId: h.owner.workspaceId,
        data: { documentId, revision: 3, title: "Opening hours", contentKind: "inline_text", sourceKind: "website", sourceId },
      },
      {
        id: failed.id,
        type: "document.failed",
        version: 1,
        occurredAt: failed.occurredAt.toISOString(),
        workspaceId: h.owner.workspaceId,
        data: { documentId, revision: 4, title: "Opening hours", contentKind: "uploaded_file", sourceKind: "upload", sourceId: uploadsSourceId, failureCode: "provider_misconfigured" },
      },
    ]);
    for (const event of page.body.events) {
      const served = servedEventSchema.parse(event);
      expect(() => workspaceEventDataSchema(served.type as WorkspaceEventType).strict().parse(served.data)).not.toThrow();
    }
  });

  it("filters by type and refuses a cursor reused for other types", async () => {
    const h = await harness();
    h.store.append({ workspaceId: h.owner.workspaceId, type: "conversation.started" });
    const handoff = h.store.append({ workspaceId: h.owner.workspaceId, type: "handoff.requested", data: { reason: "retrieval_miss" } });

    const handoffs = await request(h.app).get("/api/v1/workspace/events?types=handoff.requested").set(h.owner.headers).expect(200);
    expect(handoffs.body.events.map((event: { id: string }) => event.id)).toEqual([handoff.id]);

    const reused = await request(h.app)
      .get(`/api/v1/workspace/events?types=routine.completed&after=${encodeURIComponent(handoffs.body.nextCursor)}`)
      .set(h.owner.headers)
      .expect(400);
    expect(reused.body.error.code).toBe("cursor_filter_mismatch");
  });

  it("refuses an invalid query", async () => {
    const h = await harness();

    await request(h.app).get("/api/v1/workspace/events?types=source.synced").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/workspace/events?types=,").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/workspace/events?limit=101").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/workspace/events?after=not-a-cursor").set(h.owner.headers).expect(400);
    await request(h.app).get("/api/v1/workspace/events?workspaceId=other").set(h.owner.headers).expect(400);
  });

  describe("governance", () => {
    it("declares the route for sessions and machine credentials under the event log permission", () => {
      expect(apiPrincipalRoutePolicy["GET /api/v1/workspace/events"]).toEqual({
        permission: "workspace.events.read",
        allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
        sessionOnly: false,
      });
    });

    it("serves an API token, the way an automation polls", async () => {
      const h = await harness();
      const { token, workspaceId } = await issueTestToken(h.app);
      const event = h.store.append({ workspaceId, type: "contact_request.created", data: { contactRequestId: randomUUID(), values: { email: "ada@example.com" } } });

      const page = await request(h.app).get("/api/v1/workspace/events").set({ Authorization: `Bearer ${token}` }).expect(200);

      expect(page.body.events.map((served: { id: string }) => served.id)).toEqual([event.id]);
    });

    it("refuses a caller without the event log permission, and a request with no credential", async () => {
      const h = await harness();
      vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
        if (permission === "workspace.events.read") throw forbidden("You do not have permission to perform this action");
        return null;
      });

      await request(h.app).get("/api/v1/workspace/events").set(h.owner.headers).expect(403);
      await request(h.app).get("/api/v1/workspace/events").expect(401);
    });

    it("leaves pending decisions out for a caller without takeover, and refuses them by name", async () => {
      const h = await harness();
      h.store.append({ workspaceId: h.owner.workspaceId, type: "conversation.started" });
      h.store.append({ workspaceId: h.owner.workspaceId, type: "decision.pending" });
      vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockResolvedValue(null);
      vi.spyOn(h.dependencies.accountAccessService, "hasPermission")
        .mockImplementation(async ({ permission }) => permission !== "workspace.conversation.takeover");

      const unfiltered = await request(h.app).get("/api/v1/workspace/events").set(h.owner.headers).expect(200);
      expect(unfiltered.body.events.map((event: { type: string }) => event.type)).toEqual(["conversation.started"]);

      const named = await request(h.app).get("/api/v1/workspace/events?types=decision.pending").set(h.owner.headers).expect(403);
      expect(named.body.error.code).toBe("event_type_not_permitted");
    });

    it("leaves document events out for a caller who may not read documents, and refuses them by name", async () => {
      const h = await harness();
      h.store.append({ workspaceId: h.owner.workspaceId, type: "conversation.started" });
      h.store.append({
        workspaceId: h.owner.workspaceId,
        type: "document.processed",
        data: { documentId: randomUUID(), revision: 1, title: "Opening hours", contentKind: "inline_text", sourceKind: null, sourceId: null },
      });
      vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockResolvedValue(null);
      vi.spyOn(h.dependencies.accountAccessService, "hasPermission")
        .mockImplementation(async ({ permission }) => permission !== "workspace.documents.read");

      const unfiltered = await request(h.app).get("/api/v1/workspace/events").set(h.owner.headers).expect(200);
      expect(unfiltered.body.events.map((event: { type: string }) => event.type)).toEqual(["conversation.started"]);

      for (const types of ["document.processed", "document.failed", "conversation.started,document.failed"]) {
        const named = await request(h.app).get(`/api/v1/workspace/events?types=${types}`).set(h.owner.headers).expect(403);
        expect(named.body.error.code).toBe("event_type_not_permitted");
      }
    });

    it("answers 410 to a cursor older than the retention window", async () => {
      const h = await harness();
      const aged = encodeLogCursor({ tx: "100", position: "1" }, null, new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000));

      const expired = await request(h.app).get(`/api/v1/workspace/events?after=${encodeURIComponent(aged)}`).set(h.owner.headers).expect(410);

      expect(expired.body.error.code).toBe("cursor_expired");
    });
  });
});
