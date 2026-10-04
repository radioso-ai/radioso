import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { apiPrincipalRoutePolicy } from "../../src/app/http/apiPrincipalRoutePolicy.js";
import { operationPermissionRequirements } from "../../src/app/http/openapi/operationPermissionRequirements.js";
import { CustomerReplyDeliveryDispatcher } from "../../src/modules/customerReplyDelivery/public.js";
import { EmailHeldReplyChannelScope, emailMailboxPolicyRef } from "../../src/modules/emailChannel/heldReplyChannelScope.js";
import { EmailCustomerReplyDeliverer } from "../../src/modules/emailChannel/operator/emailCustomerReplyDeliverer.js";
import type { HeldReplyRecord } from "../../src/modules/handoff/public.js";
import { forbidden } from "../../src/shared/domain/errors.js";
import { InMemoryEmailDomains, InMemoryEmailMailboxes } from "../support/inMemoryEmailChannel.js";
import { createInMemoryHeldReplyService } from "../support/inMemoryHeldReplies.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

const harness = async (options: Omit<Parameters<typeof createInMemoryHeldReplyService>[0], "audit"> = {}) => {
  const audit = { record: vi.fn(async (_event: unknown) => undefined) };
  const held = createInMemoryHeldReplyService({ ...options, audit });
  const { app, dependencies } = createTestApp({ heldReplies: held.service });
  const signIn = async () => {
    const session = await issueTestSession(app, `held-replies-${randomUUID()}@example.com`);
    return { ...session, headers: adminSessionHeaders(session) };
  };
  const owner = await signIn();
  /** A held reply on a new email conversation of the workspace, pending unless told otherwise. */
  const seed = (overrides: Partial<HeldReplyRecord> & { workspaceId?: string; ownershipVersion?: number } = {}) => {
    const workspaceId = overrides.workspaceId ?? owner.workspaceId;
    const conversationId = overrides.conversationId ?? held.seedConversation(workspaceId, overrides.ownershipVersion ?? 0);
    return held.heldReplies.seed({ agentId: AGENT, ...overrides, workspaceId, conversationId });
  };
  return { app, dependencies, audit, held, owner, signIn, seed };
};

type Harness = Awaited<ReturnType<typeof harness>>;
type Headers = Record<string, string>;

const auditEvents = (h: Harness) =>
  (h.audit.record.mock.calls as unknown as [{ eventType: string; workspaceId: string; accountId: string | null; metadata: Record<string, unknown> }][])
    .map(([event]) => event)
    .filter((event) => event.eventType === "hitl.held_reply");

/** Denies every permission but the ones named, as a narrower role would. */
const allowOnly = (h: Harness, ...permissions: string[]) =>
  vi.spyOn(h.dependencies.accountAccessService, "requirePermission").mockImplementation(async ({ permission }) => {
    if (permissions.includes(permission)) return null;
    throw forbidden("You do not have permission to perform this action");
  });

const stateOf = (h: Harness, heldReplyId: string) => h.held.heldReplies.rows.get(heldReplyId)?.state;

const current = (h: Harness, conversationId: string, headers: Headers = h.owner.headers) =>
  request(h.app).get(`/api/v1/conversations/${conversationId}/held-reply`).set(headers);

const release = (h: Harness, held: { conversationId: string; id: string }, body: Record<string, unknown> = {}, headers: Headers = h.owner.headers) =>
  request(h.app).post(`/api/v1/conversations/${held.conversationId}/held-replies/${held.id}/release`).set(headers).send(body);

const discard = (h: Harness, held: { conversationId: string; id: string }, headers: Headers = h.owner.headers) =>
  request(h.app).post(`/api/v1/conversations/${held.conversationId}/held-replies/${held.id}/discard`).set(headers);

/** The wire shape of a pending held reply as it was seeded: operator-facing, with the draft's presentation left out. */
const pendingWire = (record: HeldReplyRecord) => ({
  id: record.id,
  conversationId: record.conversationId,
  agentId: record.agentId,
  state: "pending",
  holdReason: "draft_mode",
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false, reason: null } },
  dependsOnSuppressedAction: true,
  suppressedEffects: [{ skillName: "issue_refund" }],
  draftText: "Your refund was issued on Monday.",
  editedText: null,
  createdAt: record.createdAt.toISOString(),
  decidedAt: null,
  releaserUserId: null,
  editorUserId: null,
  attentionOpen: true,
  trace: null,
});

describe("held replies contract", () => {
  describe("list", () => {
    it("lists the workspace's held replies waiting for a teammate, newest first, page by page", async () => {
      const h = await harness();
      const oldest = h.seed();
      const middle = h.seed();
      const newest = h.seed();
      h.seed({ workspaceId: randomUUID() });

      const first = await request(h.app).get("/api/v1/held-replies?limit=2").set(h.owner.headers).expect(200);

      expect(first.body.items).toEqual([pendingWire(newest), pendingWire(middle)]);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(h.app)
        .get(`/api/v1/held-replies?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
        .set(h.owner.headers)
        .expect(200);
      expect(second.body).toEqual({ items: [pendingWire(oldest)], nextCursor: null });
    });

    it("narrows to one agent, and with attention=all includes the decided and automatically queued ones", async () => {
      const h = await harness();
      const mine = h.seed();
      const theirs = h.seed({ agentId: OTHER_AGENT });
      const sent = h.seed({ state: "released", attentionClearedAt: new Date(), attentionClearedReason: "released", decidedAt: new Date() });
      const queued = h.seed({ state: "queued_auto" });

      const open = await request(h.app).get("/api/v1/held-replies").set(h.owner.headers).expect(200);
      expect(open.body.items.map((item: { id: string }) => item.id)).toEqual([theirs.id, mine.id]);

      const every = await request(h.app).get(`/api/v1/held-replies?attention=all&agentId=${AGENT}`).set(h.owner.headers).expect(200);
      expect(every.body.items).toEqual([
        expect.objectContaining({ id: queued.id, state: "queued_auto", attentionOpen: false }),
        expect.objectContaining({ id: sent.id, state: "released", attentionOpen: false }),
        expect.objectContaining({ id: mine.id, state: "pending", attentionOpen: true }),
      ]);
    });

    it("refuses an invalid query", async () => {
      const h = await harness();

      await request(h.app).get("/api/v1/held-replies?limit=101").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/held-replies?attention=closed").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/held-replies?agentId=not-a-uuid").set(h.owner.headers).expect(400);
      await request(h.app).get("/api/v1/held-replies?cursor=not-a-cursor").set(h.owner.headers).expect(400);
    });
  });

  describe("current", () => {
    it("answers the conversation's newest held reply under a heldReply root", async () => {
      const h = await harness();
      const superseded = h.seed({ state: "superseded", supersededReason: "newer_inbound", attentionClearedAt: new Date(), attentionClearedReason: "superseded" });
      const latest = h.seed({ conversationId: superseded.conversationId });

      const response = await current(h, latest.conversationId).expect(200);

      expect(response.body).toEqual({ heldReply: pendingWire(latest) });
    });

    it("answers a null heldReply for a conversation with none", async () => {
      const h = await harness();
      const conversationId = h.held.seedConversation(h.owner.workspaceId);

      expect((await current(h, conversationId).expect(200)).body).toEqual({ heldReply: null });
    });

    it("answers 404 for another workspace's conversation and an unknown one, and 400 for a malformed id", async () => {
      const h = await harness();
      const held = h.seed();
      const stranger = await h.signIn();

      await current(h, held.conversationId, stranger.headers).expect(404);
      await current(h, randomUUID()).expect(404);
      await current(h, "not-a-uuid").expect(400);
    });
  });

  describe("release", () => {
    it("sends the draft unchanged as the agent's message, queues its delivery, and audits the release once", async () => {
      const h = await harness();
      const held = h.seed();

      const released = await release(h, held).expect(201);

      expect(released.body).toEqual({
        heldReply: {
          ...pendingWire(held),
          state: "released",
          decidedAt: expect.any(String),
          releaserUserId: h.owner.userId,
          attentionOpen: false,
        },
        messageId: expect.any(String),
        delivery: "queued",
      });
      const { messageId } = released.body as { messageId: string };
      expect(h.held.messages).toEqual([expect.objectContaining({ id: messageId, content: "Your refund was issued on Monday.", source: "ai_agent" })]);
      expect(h.held.outbox).toEqual([expect.objectContaining({ idempotencyKey: `email:send:msg:${messageId}` })]);
      expect(h.held.activities).toContainEqual(expect.objectContaining({
        kind: "held_reply_released",
        conversationId: held.conversationId,
        actorUserId: h.owner.userId,
        detail: { heldReplyId: held.id, messageId, edited: false },
      }));
      expect(auditEvents(h)).toEqual([expect.objectContaining({
        accountId: h.owner.accountId,
        workspaceId: h.owner.workspaceId,
        metadata: {
          action: "released",
          actorUserId: h.owner.userId,
          heldReplyId: held.id,
          conversationId: held.conversationId,
          releaserUserId: h.owner.userId,
          messageId,
        },
      })]);
    });

    it("sends a teammate's edit as their own message and keeps the agent's draft", async () => {
      const h = await harness();
      const held = h.seed();

      const released = await release(h, held, { editedText: "Your refund went out on Monday. — Dana" }).expect(201);

      expect(released.body.heldReply).toMatchObject({
        state: "edited",
        draftText: "Your refund was issued on Monday.",
        editedText: "Your refund went out on Monday. — Dana",
        editorUserId: h.owner.userId,
        releaserUserId: h.owner.userId,
      });
      expect(h.held.messages).toEqual([expect.objectContaining({ id: released.body.messageId, content: "Your refund went out on Monday. — Dana" })]);
      expect(auditEvents(h)).toEqual([expect.objectContaining({
        metadata: expect.objectContaining({ action: "edited_released", editorUserId: h.owner.userId, messageId: released.body.messageId }),
      })]);
    });

    it("refuses a held reply that is no longer pending, and carries the held reply as it is now", async () => {
      const h = await harness();
      const held = h.seed();
      await release(h, held).expect(201);

      const again = await release(h, held).expect(409);

      expect(again.body.error.code).toBe("held_reply_not_pending");
      expect(again.body.error.details).toEqual({ heldReply: expect.objectContaining({ id: held.id, state: "released" }) });
      expect(h.held.messages).toHaveLength(1);
      expect(auditEvents(h)).toHaveLength(1);
    });

    it("refuses once the conversation changed hands since the draft was held, and sends nothing", async () => {
      const h = await harness();
      const held = h.seed();
      h.held.changeOwnership(held.conversationId, 1);

      const refused = await release(h, held).expect(409);

      expect(refused.body.error.code).toBe("ownership_changed");
      expect(refused.body.error.details).toEqual({ heldReply: expect.objectContaining({ id: held.id, state: "pending" }) });
      expect(stateOf(h, held.id)).toBe("pending");
      expect(h.held.outbox).toEqual([]);
      expect(auditEvents(h)).toEqual([]);
    });

    it("refuses once the channel's policy changed since the draft was held", async () => {
      const h = await harness({ lockedPolicyVersion: 6 });
      const held = h.seed();

      const refused = await release(h, held).expect(409);

      expect(refused.body.error.code).toBe("policy_changed");
      expect(stateOf(h, held.id)).toBe("pending");
      expect(auditEvents(h)).toEqual([]);
    });

    it.each([
      ["the channel cannot vouch for the policy", { lockedPolicyVersion: null }],
      ["the conversation has no delivery route", { route: "none" as const }],
    ])("refuses as channel_not_ready when %s", async (_case, options) => {
      const h = await harness(options);
      const held = h.seed();

      const refused = await release(h, held).expect(409);

      expect(refused.body.error.code).toBe("channel_not_ready");
      expect(stateOf(h, held.id)).toBe("pending");
      expect(h.held.messages).toEqual([]);
    });

    it("surfaces the channel's refusal when its sending domain is not verified, before anything is written", async () => {
      const h = await harness({ route: "not_verified" });
      const held = h.seed();

      const refused = await release(h, held).expect(409);

      expect(refused.body.error.code).toBe("email_sending_not_verified");
      expect(stateOf(h, held.id)).toBe("pending");
      expect(h.held.messages).toEqual([]);
      expect(auditEvents(h)).toEqual([]);
    });

    describe("through the email channel's own scope and delivery", () => {
      /**
       * A held reply on an email conversation whose mailbox sends from a domain in `sendingStatus`,
       * released through email's real channel scope and reply deliverer over in-memory rows.
       */
      const emailRelease = async (sendingStatus: "pending" | "verified") => {
        const clock = () => new Date("2026-10-04T09:00:00.000Z");
        const domains = new InMemoryEmailDomains(clock);
        const mailboxes = new InMemoryEmailMailboxes(clock);
        // What the scope locks; a test that removes the mailbox while the release waits swaps it.
        const lockPolicy = vi.fn((mailboxId: string) => mailboxes.findActiveById(mailboxId));
        const h = await harness({
          channel: {
            scope: new EmailHeldReplyChannelScope({ mailboxes: { lockPolicy }, domains }),
            delivery: new CustomerReplyDeliveryDispatcher({
              email: new EmailCustomerReplyDeliverer({ mailboxes, domains, ownership: { versionOf: async () => 0 } }),
            }),
          },
        });
        const domain = domains.seed({ workspaceId: h.owner.workspaceId, domain: "customer.test", sendingStatus });
        const mailbox = mailboxes.seed({ workspaceId: h.owner.workspaceId, domainId: domain.id, address: "support@customer.test" });
        const conversationId = h.held.seedConversation(h.owner.workspaceId, 0, {
          provider: "email",
          mailbox: { id: mailbox.id, address: mailbox.address },
          threadKey: "thread-1",
          participant: { address: "pat@example.org" },
        } as never);
        const held = h.seed({ conversationId, policy: { ref: emailMailboxPolicyRef(mailbox.id), version: mailbox.policyVersion } });
        return { h, held, mailboxes, mailbox, lockPolicy };
      };

      it("refuses as email_sending_not_verified, naming the step, when the mailbox's sending domain is not verified", async () => {
        const { h, held } = await emailRelease("pending");

        const refused = await release(h, held).expect(409);

        expect(refused.body.error.code).toBe("email_sending_not_verified");
        expect(refused.body.error.details).toEqual({ step: "verify_sending_domain", domain: "customer.test" });
        expect(stateOf(h, held.id)).toBe("pending");
        expect(h.held.messages).toEqual([]);
        expect(auditEvents(h)).toEqual([]);
      });

      // Delivery is resolved before the transaction opens, so a mailbox already removed is refused
      // there, by the same refusal a teammate's reply gets, naming the step that restores sending.
      it("refuses a mailbox removed before the release as email_sending_not_verified, naming add_mailbox", async () => {
        const { h, held, mailboxes, mailbox } = await emailRelease("verified");
        await mailboxes.markRemoved(mailbox.workspaceId, mailbox.id);

        const refused = await release(h, held).expect(409);

        expect(refused.body.error.code).toBe("email_sending_not_verified");
        expect(refused.body.error.details).toEqual({ step: "add_mailbox", domain: "customer.test" });
        expect(stateOf(h, held.id)).toBe("pending");
      });

      it("refuses as channel_not_ready when the mailbox is removed before the release can lock its policy", async () => {
        const { h, held, mailboxes, mailbox, lockPolicy } = await emailRelease("verified");
        lockPolicy.mockImplementationOnce(async (mailboxId) => {
          await mailboxes.markRemoved(mailbox.workspaceId, mailbox.id);
          return mailboxes.findActiveById(mailboxId);
        });

        const refused = await release(h, held).expect(409);

        expect(refused.body.error.code).toBe("channel_not_ready");
        expect(refused.body.error.details).toEqual({ heldReply: expect.objectContaining({ id: held.id, state: "pending" }) });
        expect(stateOf(h, held.id)).toBe("pending");
        expect(h.held.messages).toEqual([]);
        expect(auditEvents(h)).toEqual([]);
      });

      it("sends once the mailbox can send", async () => {
        const { h, held } = await emailRelease("verified");

        await release(h, held).expect(201);

        expect(stateOf(h, held.id)).toBe("released");
        expect(h.held.outbox).toEqual([expect.objectContaining({ type: "email.send", payload: expect.objectContaining({ trigger: "held_release", heldReplyId: held.id }) })]);
      });
    });

    it("refuses an empty, oversized or unknown edit field", async () => {
      const h = await harness();
      const held = h.seed();

      await release(h, held, { editedText: "" }).expect(400);
      await release(h, held, { editedText: "x".repeat(20_001) }).expect(400);
      await release(h, held, { text: "Hello" }).expect(400);
      expect(stateOf(h, held.id)).toBe("pending");
    });

    it("answers 404 for another workspace's conversation and an unknown held reply", async () => {
      const h = await harness();
      const held = h.seed();
      const stranger = await h.signIn();

      await release(h, held, {}, stranger.headers).expect(404);
      await release(h, { conversationId: held.conversationId, id: randomUUID() }).expect(404);
      await release(h, { conversationId: held.conversationId, id: "not-a-uuid" }).expect(400);
      expect(stateOf(h, held.id)).toBe("pending");
    });
  });

  describe("discard", () => {
    it("sets the draft aside, keeps the conversation waiting for a teammate, and audits the discard once", async () => {
      const h = await harness();
      const held = h.seed();

      const discarded = await discard(h, held).expect(200);

      expect(discarded.body).toEqual({ ...pendingWire(held), state: "discarded", decidedAt: expect.any(String), attentionOpen: true });
      expect(h.held.messages).toEqual([]);
      expect(h.held.activities).toContainEqual(expect.objectContaining({ kind: "held_reply_discarded", detail: { heldReplyId: held.id } }));
      expect(auditEvents(h)).toEqual([expect.objectContaining({
        workspaceId: h.owner.workspaceId,
        metadata: expect.objectContaining({ action: "discarded", heldReplyId: held.id, actorUserId: h.owner.userId }),
      })]);

      const again = await discard(h, held).expect(409);
      expect(again.body.error.code).toBe("held_reply_not_pending");
      expect(again.body.error.details).toEqual({ heldReply: expect.objectContaining({ id: held.id, state: "discarded" }) });
      expect(auditEvents(h)).toHaveLength(1);
    });

    it("answers 404 for another workspace's conversation and an unknown held reply", async () => {
      const h = await harness();
      const held = h.seed();
      const stranger = await h.signIn();

      await discard(h, held, stranger.headers).expect(404);
      await discard(h, { conversationId: held.conversationId, id: randomUUID() }).expect(404);
      expect(stateOf(h, held.id)).toBe("pending");
    });
  });

  describe("governance", () => {
    const routes = [
      ["GET", "/api/v1/held-replies"],
      ["GET", "/api/v1/conversations/:conversationId/held-reply"],
      ["POST", "/api/v1/conversations/:conversationId/held-replies/:heldReplyId/release"],
      ["POST", "/api/v1/conversations/:conversationId/held-replies/:heldReplyId/discard"],
    ] as const;

    it("declares every route session-only under the conversation takeover permission", () => {
      for (const [method, path] of routes) {
        expect(apiPrincipalRoutePolicy[`${method} ${path}`]).toEqual({
          permission: "workspace.conversation.takeover",
          allowedPrincipalKinds: ["session_user"],
          sessionOnly: true,
        });
      }
      expect(operationPermissionRequirements.listHeldReplies).toEqual(["workspace.conversation.takeover"]);
      expect(operationPermissionRequirements.getCurrentHeldReply).toEqual(["workspace.conversation.takeover"]);
    });

    it("refuses a machine credential on every route", async () => {
      const h = await harness();
      const held = h.seed();
      const { token } = await issueTestToken(h.app);
      const bearer = { Authorization: `Bearer ${token}` };

      await request(h.app).get("/api/v1/held-replies").set(bearer).expect(401);
      await current(h, held.conversationId, bearer).expect(401);
      await release(h, held, {}, bearer).expect(401);
      await discard(h, held, bearer).expect(401);
      expect(stateOf(h, held.id)).toBe("pending");
    });

    it("refuses a teammate without the conversation takeover permission", async () => {
      const h = await harness();
      const held = h.seed();
      allowOnly(h, "workspace.history.read", "workspace.settings.read");

      await request(h.app).get("/api/v1/held-replies").set(h.owner.headers).expect(403);
      await current(h, held.conversationId).expect(403);
      await release(h, held).expect(403);
      await discard(h, held).expect(403);
      expect(stateOf(h, held.id)).toBe("pending");
      expect(auditEvents(h)).toEqual([]);
    });
  });
});
