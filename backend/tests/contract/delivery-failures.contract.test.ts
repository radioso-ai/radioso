import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { operationPermissionRequirements } from "../../src/app/http/openapi/operationPermissionRequirements.js";
import {
  DeliveryFailureDecisions,
  type DeliveryFailureResolverPort,
} from "../../src/modules/customerReplyDelivery/public.js";
import { AppError, forbidden } from "../../src/shared/domain/errors.js";
import { createInMemoryDeliveryFailures } from "../support/inMemoryDeliveryFailures.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

type Kind = "bounced" | "failed" | "uncertain" | "halted";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

const harness = async (options: { resolver?: "settles" | "refuses_unverified" | "absent" } = {}) => {
  const audit = { record: vi.fn(async () => undefined) };
  const agents = new Map<string, string>();
  const store = createInMemoryDeliveryFailures({ agentOf: (conversationId) => agents.get(conversationId) ?? null });
  // The channel's half: settles its send and clears the failure it carried, as the email channel does.
  const resolve = vi.fn<DeliveryFailureResolverPort["resolve"]>(async ({ failure, userId }) => {
    if (options.resolver === "refuses_unverified") {
      throw new AppError(409, "email_sending_not_verified", "The sending domain is not verified.");
    }
    await store.failures.clear({ conversationId: failure.conversationId, messageId: failure.messageId, reason: "operator_resolved", userId });
    return { sendIntentId: "send-intent-2" };
  });
  const deliveryFailures = new DeliveryFailureDecisions({
    failures: store.failures,
    resolver: options.resolver === "absent" ? null : { resolve },
    audit,
    logger: { warn: vi.fn() },
  });
  const { app, dependencies } = createTestApp({ deliveryFailures });
  const signIn = async () => {
    const session = await issueTestSession(app, `delivery-failures-${randomUUID()}@example.com`);
    return { ...session, headers: adminSessionHeaders(session) };
  };
  const owner = await signIn();
  const seed = async (kind: Kind, overrides: { workspaceId?: string; agentId?: string; messageId?: string | null } = {}) => {
    const conversationId = randomUUID();
    const messageId = overrides.messageId === undefined ? randomUUID() : overrides.messageId;
    agents.set(conversationId, overrides.agentId ?? AGENT);
    await store.failures.open({
      workspaceId: overrides.workspaceId ?? owner.workspaceId,
      conversationId,
      messageId,
      provider: "email",
      kind,
      detailCode: kind === "bounced" ? "mailbox_full" : null,
    });
    const failure = store.rows.find((row) => row.conversationId === conversationId);
    if (!failure) throw new Error("seed failed");
    return failure;
  };
  return { app, dependencies, audit, resolve, store, owner, signIn, seed };
};

type Harness = Awaited<ReturnType<typeof harness>>;

const auditEvents = (h: Harness) =>
  (h.audit.record.mock.calls as unknown as [{ eventType: string; workspaceId: string; accountId: string; metadata: Record<string, unknown> }][])
    .map(([event]) => event)
    .filter((event) => event.eventType === "hitl.delivery_failure");

/** Denies every permission but the ones named, as a narrower role would. */
const allowOnly = (h: Harness, ...permissions: string[]) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permissions.includes(permission)) return null;
    throw forbidden("You do not have permission to perform this action");
  });

type Headers = Record<string, string>;

const acknowledge = (h: Harness, failureId: string, headers: Headers = h.owner.headers) =>
  request(h.app).post(`/api/v1/delivery-failures/${failureId}/acknowledge`).set(headers);

const resolveFailure = (h: Harness, failureId: string, decision: string, headers: Headers = h.owner.headers) =>
  request(h.app).post(`/api/v1/delivery-failures/${failureId}/resolve`).set(headers).send({ decision });

describe("delivery failures contract", () => {
  describe("list", () => {
    it("lists the workspace's open failures newest first, page by page, with sanitized detail only", async () => {
      const h = await harness();
      const oldest = await h.seed("halted");
      const middle = await h.seed("bounced");
      const newest = await h.seed("uncertain", { messageId: null });
      await h.seed("failed", { workspaceId: randomUUID() });

      const first = await request(h.app).get("/api/v1/delivery-failures?limit=2").set(h.owner.headers).expect(200);

      expect(first.body.items).toEqual([
        {
          id: newest.id,
          conversationId: newest.conversationId,
          messageId: null,
          provider: "email",
          kind: "uncertain",
          detailCode: null,
          openedAt: newest.openedAt.toISOString(),
          clearedAt: null,
          clearReason: null,
        },
        expect.objectContaining({ id: middle.id, kind: "bounced", detailCode: "mailbox_full" }),
      ]);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(h.app)
        .get(`/api/v1/delivery-failures?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(h.owner.headers)
        .expect(200);
      expect(second.body).toEqual({ items: [expect.objectContaining({ id: oldest.id })], nextCursor: null });
    });

    it("narrows to one agent, and with state=all includes the cleared ones", async () => {
      const h = await harness();
      const mine = await h.seed("bounced");
      const theirs = await h.seed("failed", { agentId: OTHER_AGENT });
      await acknowledge(h, mine.id).expect(200);

      const open = await request(h.app).get("/api/v1/delivery-failures").set(h.owner.headers).expect(200);
      expect(open.body.items.map((item: { id: string }) => item.id)).toEqual([theirs.id]);

      const scoped = await request(h.app).get(`/api/v1/delivery-failures?state=all&agentId=${AGENT}`).set(h.owner.headers).expect(200);
      expect(scoped.body.items).toEqual([
        expect.objectContaining({ id: mine.id, clearedAt: expect.any(String), clearReason: "acknowledged" }),
      ]);
    });

    it("refuses an invalid query", async () => {
      const h = await harness();

      await request(h.app).get("/api/v1/delivery-failures?limit=101").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/delivery-failures?state=cleared").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/delivery-failures?agentId=not-a-uuid").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/delivery-failures?cursor=not-a-cursor").set(h.owner.headers).expect(400);
    });
  });

  describe("acknowledge", () => {
    it("clears the failure as acknowledged by the teammate, records the activity and audits it once", async () => {
      const h = await harness();
      const failure = await h.seed("bounced");

      const acknowledged = await acknowledge(h, failure.id).expect(200);

      expect(acknowledged.body).toMatchObject({ id: failure.id, clearedAt: expect.any(String), clearReason: "acknowledged" });
      expect(h.store.rows.find((row) => row.id === failure.id)?.clearedByUserId).toBe(h.owner.userId);
      expect(h.store.activities.at(-1)).toEqual({
        kind: "delivery_failure_cleared",
        conversationId: failure.conversationId,
        workspaceId: h.owner.workspaceId,
        actorUserId: h.owner.userId,
        detail: { failureId: failure.id, messageId: failure.messageId, reason: "acknowledged" },
      });
      expect(auditEvents(h)).toEqual([expect.objectContaining({
        accountId: h.owner.accountId,
        workspaceId: h.owner.workspaceId,
        eventStatus: "success",
        metadata: {
          action: "acknowledged",
          failureId: failure.id,
          conversationId: failure.conversationId,
          provider: "email",
          kind: "bounced",
          actorUserId: h.owner.userId,
        },
      })]);

      const again = await acknowledge(h, failure.id).expect(409);
      expect(again.body.error.code).toBe("already_cleared");
      expect(auditEvents(h)).toHaveLength(1);
    });

    it("answers 404 for another workspace's failure, an unknown id and a malformed one", async () => {
      const h = await harness();
      const failure = await h.seed("bounced");
      const stranger = await h.signIn();

      await acknowledge(h, failure.id, stranger.headers).expect(404);
      await acknowledge(h, randomUUID()).expect(404);
      await acknowledge(h, "not-a-uuid").expect(400);
      expect(h.store.rows.find((row) => row.id === failure.id)?.clearedAt).toBeNull();
    });
  });

  describe("resolve", () => {
    it("marks an uncertain send as sent through the channel and audits the decision", async () => {
      const h = await harness();
      const failure = await h.seed("uncertain");

      const resolved = await resolveFailure(h, failure.id, "marked_sent").expect(200);

      expect(resolved.body).toMatchObject({ id: failure.id, clearedAt: expect.any(String), clearReason: "operator_resolved" });
      expect(h.resolve).toHaveBeenCalledWith({
        workspaceId: h.owner.workspaceId,
        failure: expect.objectContaining({ id: failure.id, kind: "uncertain" }),
        decision: "marked_sent",
        userId: h.owner.userId,
      });
      expect(auditEvents(h)).toEqual([expect.objectContaining({
        workspaceId: h.owner.workspaceId,
        metadata: {
          action: "resolved",
          failureId: failure.id,
          conversationId: failure.conversationId,
          sendIntentId: "send-intent-2",
          decision: "marked_sent",
          actorUserId: h.owner.userId,
        },
      })]);
    });

    it.each([["uncertain"], ["halted"]] as const)("resends a %s reply through the channel", async (kind) => {
      const h = await harness();
      const failure = await h.seed(kind);

      await resolveFailure(h, failure.id, "resend").expect(200);

      expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ decision: "resend" }));
      expect(auditEvents(h)).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ decision: "resend" }) })]);
    });

    it.each([
      ["halted", "marked_sent"],
      ["bounced", "marked_sent"],
      ["bounced", "resend"],
      ["failed", "marked_sent"],
      ["failed", "resend"],
    ] as const)("refuses %s with %s as not resolvable, before the channel is asked", async (kind, decision) => {
      const h = await harness();
      const failure = await h.seed(kind);

      const refused = await resolveFailure(h, failure.id, decision).expect(409);

      expect(refused.body.error.code).toBe("not_resolvable");
      expect(h.resolve).not.toHaveBeenCalled();
      expect(auditEvents(h)).toEqual([]);
    });

    it("refuses a failure that is already cleared", async () => {
      const h = await harness();
      const failure = await h.seed("uncertain");
      await acknowledge(h, failure.id).expect(200);

      const refused = await resolveFailure(h, failure.id, "resend").expect(409);

      expect(refused.body.error.code).toBe("not_resolvable");
      expect(h.resolve).not.toHaveBeenCalled();
    });

    it("surfaces the channel's refusal when sending is not ready, and leaves the failure open and unaudited", async () => {
      const h = await harness({ resolver: "refuses_unverified" });
      const failure = await h.seed("halted");

      const refused = await resolveFailure(h, failure.id, "resend").expect(409);

      expect(refused.body.error.code).toBe("email_sending_not_verified");
      expect(h.store.rows.find((row) => row.id === failure.id)?.clearedAt).toBeNull();
      expect(auditEvents(h)).toEqual([]);
    });

    it("refuses as not resolvable when no delivering channel can settle the decision", async () => {
      const h = await harness({ resolver: "absent" });
      const failure = await h.seed("uncertain");

      const refused = await resolveFailure(h, failure.id, "resend").expect(409);

      expect(refused.body.error.code).toBe("not_resolvable");
    });

    it("answers 404 for another workspace's failure and 400 for an unknown decision", async () => {
      const h = await harness();
      const failure = await h.seed("uncertain");
      const stranger = await h.signIn();

      await resolveFailure(h, failure.id, "resend", stranger.headers).expect(404);
      await resolveFailure(h, randomUUID(), "resend").expect(404);
      await resolveFailure(h, failure.id, "retry").expect(400);
      expect(h.resolve).not.toHaveBeenCalled();
    });
  });

  describe("governance", () => {
    const routes = [
      ["GET", "/api/v1/delivery-failures"],
      ["POST", "/api/v1/delivery-failures/:failureId/acknowledge"],
      ["POST", "/api/v1/delivery-failures/:failureId/resolve"],
    ] as const;

    it("declares every route session-only under the conversation takeover permission", () => {
      for (const [method, path] of routes) {
        expect(apiPrincipalRoutePolicy[`${method} ${path}`]).toEqual({
          permission: "workspace.conversation.takeover",
          allowedPrincipalKinds: ["session_user"],
          sessionOnly: true,
        });
      }
      expect(operationPermissionRequirements.listDeliveryFailures).toEqual(["workspace.conversation.takeover"]);
    });

    it("refuses a machine credential on every route", async () => {
      const h = await harness();
      const failure = await h.seed("uncertain");
      const { token } = await issueTestToken(h.app);
      const bearer = { Authorization: `Bearer ${token}` };

      await request(h.app).get("/api/v1/delivery-failures").set(bearer).expect(401);
      await acknowledge(h, failure.id, bearer).expect(401);
      await resolveFailure(h, failure.id, "resend", bearer).expect(401);
    });

    it("refuses a teammate without the conversation takeover permission", async () => {
      const h = await harness();
      const failure = await h.seed("uncertain");
      allowOnly(h, "workspace.history.read", "workspace.settings.read");

      await request(h.app).get("/api/v1/delivery-failures").set(h.owner.headers).expect(403);
      await acknowledge(h, failure.id).expect(403);
      await resolveFailure(h, failure.id, "resend").expect(403);
      expect(h.store.rows.find((row) => row.id === failure.id)?.clearedAt).toBeNull();
      expect(h.resolve).not.toHaveBeenCalled();
    });
  });
});
