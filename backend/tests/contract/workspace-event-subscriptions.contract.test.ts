import { randomUUID } from "node:crypto";

import { Ajv } from "ajv";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { createOpenApiDocument } from "../../src/app/http/openapi/openApiDocument.js";
import { connectorKeySealer, EventSubscriptionService, type EventSubscriptionView } from "../../src/modules/workspaceEventLog/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { InMemoryWorkspaceEventSubscriptionStore, taggingSealer } from "../support/inMemoryWorkspaceEventSubscriptions.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

/** Every served subscription must validate against the `EventSubscription` component the API publishes. */
const publishedSubscription = new Ajv({ strict: false, validateFormats: false })
  .compile(createOpenApiDocument().components?.schemas?.EventSubscription as object);
const subscriptionView = {
  parse: (value: unknown): EventSubscriptionView => {
    if (!publishedSubscription(value)) throw new Error(JSON.stringify(publishedSubscription.errors));
    return value as EventSubscriptionView;
  },
};

const PRIVATE_HOST = "internal.example";

const harness = async (options: { sealer?: typeof taggingSealer } = {}) => {
  const store = new InMemoryWorkspaceEventSubscriptionStore();
  const audit = { record: vi.fn(async () => undefined) };
  const service = new EventSubscriptionService({
    store,
    sealer: options.sealer ?? taggingSealer,
    audit,
    // Stands in for the DNS-resolving guard: one host resolves to a private address.
    assertPublicUrl: async (url) => {
      if (new URL(url).hostname === PRIVATE_HOST) throw new Error("not public");
    },
    allowHttpLoopback: false,
  });
  const { app, dependencies } = createTestApp({ workspaceEventSubscriptions: service });
  const { token, workspaceId } = await issueTestToken(app, `event-subscriptions-${randomUUID()}@example.com`);
  return { app, dependencies, store, audit, workspaceId, bearer: { Authorization: `Bearer ${token}` } };
};

const zapierHook = "https://hooks.zapier.example/hooks/standard/123/abc";

describe("workspace event subscriptions contract", () => {
  it("subscribes with an API token, returns the signing secret once, and never returns the target URL again", async () => {
    const h = await harness();

    const created = await request(h.app)
      .post("/api/v1/workspace/event-subscriptions")
      .set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["routine.completed", "contact_request.created"], label: "zapier" })
      .expect(201);
    expect(created.body.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const subscription = subscriptionView.parse(created.body.subscription);
    expect(subscription).toMatchObject({
      label: "zapier",
      targetHost: "hooks.zapier.example",
      eventTypes: ["routine.completed", "contact_request.created"],
      status: "active",
      disabledReason: null,
      createdBy: { kind: "personal_token" },
      lastDelivery: null,
    });

    const listed = await request(h.app).get("/api/v1/workspace/event-subscriptions").set(h.bearer).expect(200);
    expect(listed.body.subscriptions.map((item: unknown) => subscriptionView.parse(item).id)).toEqual([subscription.id]);
    const one = await request(h.app).get(`/api/v1/workspace/event-subscriptions/${subscription.id}`).set(h.bearer).expect(200);
    expect(subscriptionView.parse(one.body.subscription)).toEqual(subscription);
    for (const body of [listed.body, one.body]) {
      expect(JSON.stringify(body)).not.toContain("/hooks/standard");
      expect(JSON.stringify(body)).not.toContain(created.body.signingSecret);
    }
    const stored = h.store.rows.get(subscription.id)!;
    expect(stored.targetUrlCiphertext).toBe(taggingSealer.seal(zapierHook));
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "workspace_event_subscription.created" }));
  });

  it("unsubscribes, after which the subscription is gone", async () => {
    const h = await harness();
    const created = await request(h.app)
      .post("/api/v1/workspace/event-subscriptions")
      .set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "n8n" })
      .expect(201);
    const path = `/api/v1/workspace/event-subscriptions/${created.body.subscription.id}`;

    await request(h.app).delete(path).set(h.bearer).expect(204);

    expect((await request(h.app).get(path).set(h.bearer).expect(404)).body.error.code).toBe("not_found");
    await request(h.app).delete(path).set(h.bearer).expect(404);
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ eventType: "workspace_event_subscription.deleted" }));
  });

  it("refuses a target that is not https, or not a public host", async () => {
    const h = await harness();
    for (const targetUrl of ["http://hooks.zapier.example/a", `https://${PRIVATE_HOST}/hook`, "ftp://hooks.zapier.example/a", "hooks"]) {
      const refused = await request(h.app)
        .post("/api/v1/workspace/event-subscriptions")
        .set(h.bearer)
        .send({ targetUrl, eventTypes: ["handoff.requested"], label: "custom" })
        .expect(400);
      expect(refused.body.error.code).toBe("invalid_target_url");
    }
    expect(h.store.rows.size).toBe(0);
  });

  it("refuses an invalid body", async () => {
    const h = await harness();
    const post = (body: unknown) => request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer).send(body as object);

    await post({ targetUrl: zapierHook, eventTypes: [], label: "zapier" }).expect(400);
    await post({ targetUrl: zapierHook, eventTypes: ["source.synced"], label: "zapier" }).expect(400);
    await post({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "make" }).expect(400);
    await post({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "zapier", secret: "mine" }).expect(400);
    await request(h.app).get("/api/v1/workspace/event-subscriptions/not-a-uuid").set(h.bearer).expect(400);
  });

  it("answers 409 once the workspace holds 25 subscriptions", async () => {
    const h = await harness();
    for (let index = 0; index < 25; index += 1) {
      await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
        .send({ targetUrl: `${zapierHook}/${index}`, eventTypes: ["handoff.requested"], label: "zapier" }).expect(201);
    }

    const full = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: `${zapierHook}/25`, eventTypes: ["handoff.requested"], label: "zapier" }).expect(409);
    expect(full.body.error.code).toBe("event_subscription_limit_reached");

    // A URL the workspace already subscribed replaces its subscription, so a full workspace still takes it.
    await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: `${zapierHook}/3`, eventTypes: ["routine.completed"], label: "zapier" }).expect(201);
    expect(h.store.rows.size).toBe(25);
  });

  it("replaces the subscription with a new one when a client subscribes the same URL again", async () => {
    const h = await harness();
    const post = (eventTypes: string[]) => request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes, label: "zapier" }).expect(201);

    const first = await post(["handoff.requested"]);
    const second = await post(["handoff.requested", "routine.completed"]);

    expect(second.body.subscription.id).not.toBe(first.body.subscription.id);
    expect(second.body.subscription.eventTypes).toEqual(["handoff.requested", "routine.completed"]);
    expect(second.body.signingSecret).not.toBe(first.body.signingSecret);
    // A late unsubscribe of the replaced subscription finds nothing, and the new one stays.
    await request(h.app).delete(`/api/v1/workspace/event-subscriptions/${first.body.subscription.id}`).set(h.bearer).expect(404);
    const listed = await request(h.app).get("/api/v1/workspace/event-subscriptions").set(h.bearer).expect(200);
    expect(listed.body.subscriptions.map((item: { id: string }) => item.id)).toEqual([second.body.subscription.id]);
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "workspace_event_subscription.replaced",
      metadata: expect.objectContaining({ subscriptionId: second.body.subscription.id, previousSubscriptionId: first.body.subscription.id }),
    }));
  });

  it("refuses a target URL that carries a username or password", async () => {
    const h = await harness();

    const refused = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: "https://user:secret@hooks.zapier.example/hook", eventTypes: ["handoff.requested"], label: "custom" })
      .expect(400);

    expect(refused.body.error.code).toBe("invalid_target_url");
    expect(h.store.rows.size).toBe(0);
  });

  it("refuses every type to a caller without the event log's read permission, as each push would", async () => {
    const h = await harness();
    vi.spyOn(h.dependencies.accountAccessService, "hasPermission")
      .mockImplementation(async ({ permission }) => permission !== "workspace.events.read");

    const refused = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "zapier" }).expect(403);

    expect(refused.body.error).toMatchObject({ code: "event_type_not_permitted", details: { types: ["handoff.requested"] } });
  });

  it("answers 404 to another workspace's token, and leaves the subscription in place", async () => {
    const h = await harness();
    const created = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "zapier" }).expect(201);
    const other = await issueTestToken(h.app, `event-subscriptions-other-${randomUUID()}@example.com`);
    const path = `/api/v1/workspace/event-subscriptions/${created.body.subscription.id}`;

    await request(h.app).get(path).set({ Authorization: `Bearer ${other.token}` }).expect(404);
    await request(h.app).delete(path).set({ Authorization: `Bearer ${other.token}` }).expect(404);
    const listed = await request(h.app).get("/api/v1/workspace/event-subscriptions").set({ Authorization: `Bearer ${other.token}` }).expect(200);

    expect(listed.body.subscriptions).toEqual([]);
    expect(h.store.rows.has(created.body.subscription.id)).toBe(true);
  });

  it("answers 503 when the deployment has no key to seal the secret", async () => {
    const h = await harness({ sealer: connectorKeySealer(undefined) });

    const refused = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["handoff.requested"], label: "zapier" }).expect(503);

    expect(refused.body.error.code).toBe("encryption_not_configured");
    expect(h.store.rows.size).toBe(0);
  });

  it("refuses a type the caller may not read from the event log", async () => {
    const h = await harness();
    vi.spyOn(h.dependencies.accountAccessService, "hasPermission")
      .mockImplementation(async ({ permission }) => permission !== "workspace.conversation.takeover");

    const refused = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["handoff.requested", "decision.pending"], label: "zapier" }).expect(403);

    expect(refused.body.error.code).toBe("event_type_not_permitted");
    expect(h.store.rows.size).toBe(0);
  });

  it("subscribes document events only for a caller who may read the workspace's documents", async () => {
    const h = await harness();
    const allowed = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: zapierHook, eventTypes: ["document.processed", "document.failed"], label: "zapier" }).expect(201);
    expect(allowed.body.subscription.eventTypes).toEqual(["document.processed", "document.failed"]);

    vi.spyOn(h.dependencies.accountAccessService, "hasPermission")
      .mockImplementation(async ({ permission }) => permission !== "workspace.documents.read");
    const refused = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(h.bearer)
      .send({ targetUrl: `${zapierHook}/documents`, eventTypes: ["handoff.requested", "document.failed"], label: "zapier" }).expect(403);
    expect(refused.body.error).toMatchObject({ code: "event_type_not_permitted", details: { types: ["document.failed"] } });
  });

  it("records a dashboard teammate as the creator of a subscription made in a session", async () => {
    const h = await harness();
    const session = await issueTestSession(h.app, `event-subscriptions-session-${randomUUID()}@example.com`);

    const created = await request(h.app).post("/api/v1/workspace/event-subscriptions").set(adminSessionHeaders(session))
      .send({ targetUrl: zapierHook, eventTypes: ["conversation.started"], label: "custom" }).expect(201);

    expect(created.body.subscription.createdBy.kind).toBe("teammate");
    expect(h.store.rows.get(created.body.subscription.id)!.createdBy.userId).toBe(session.userId);
  });

  describe("governance", () => {
    it("declares every route for sessions and machine credentials under the subscription permission", () => {
      for (const route of [
        "POST /api/v1/workspace/event-subscriptions",
        "GET /api/v1/workspace/event-subscriptions",
        "GET /api/v1/workspace/event-subscriptions/:subscriptionId",
        "DELETE /api/v1/workspace/event-subscriptions/:subscriptionId",
      ]) {
        expect(apiPrincipalRoutePolicy[route]).toEqual({
          permission: "workspace.event_subscriptions.manage",
          allowedPrincipalKinds: ["session_user", "personal_api_credential", "service_account_credential"],
          sessionOnly: false,
        });
      }
    });

    it("refuses a caller without the subscription permission, and a request with no credential", async () => {
      const h = await harness();
      vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
        if (permission === "workspace.event_subscriptions.manage") throw forbidden("You do not have permission to perform this action");
        return null;
      });

      await request(h.app).get("/api/v1/workspace/event-subscriptions").set(h.bearer).expect(403);
      await request(h.app).get("/api/v1/workspace/event-subscriptions").expect(401);
    });

    it("publishes the push a subscription receives, with its signature headers and status semantics", () => {
      const document = createOpenApiDocument() as { webhooks?: Record<string, { post?: { parameters?: Array<{ name: string; in: string }>; responses?: Record<string, unknown> } }> };
      const push = document.webhooks?.workspaceEvent?.post;
      expect(push?.parameters?.filter((parameter) => parameter.in === "header").map((parameter) => parameter.name).sort())
        .toEqual(["Idempotency-Key", "X-Radioso-Signature", "X-Radioso-Timestamp"]);
      expect(Object.keys(push?.responses ?? {}).sort()).toEqual(["200", "410"]);
    });
  });
});
