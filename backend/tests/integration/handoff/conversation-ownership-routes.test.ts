import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { forbidden } from "../../../src/shared/domain/errors.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../../support/testApp.js";

const acceptInvite = async (
  app: ReturnType<typeof createTestApp>["app"],
  ownerCookie: string,
  email: string,
): Promise<{ cookie: string; workspaceId: string; accountId: string; userId: string }> => {
  const invite = await request(app)
    .post("/api/v1/account/invitations")
    .set("Cookie", ownerCookie)
    .send({ email, role: "member" });
  expect(invite.status).toBe(201);

  const token = String(invite.body.acceptanceUrl).split("/").at(-1)!;
  const password = "verysecurepassword";
  const accepted = await request(app)
    .post(`/api/v1/auth/invitations/${token}/accept`)
    .send({ email, password });
  expect(accepted.status).toBe(200);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password, preferredAccountId: accepted.body.accountId });
  expect(login.status).toBe(200);

  return {
    cookie: login.headers["set-cookie"][0],
    workspaceId: accepted.body.workspaceId as string,
    accountId: accepted.body.accountId as string,
    userId: accepted.body.userId as string,
  };
};

describe("conversation ownership routes", () => {
  it("lets an authorized member take over, reply, transfer, and hand back with audit", async () => {
    const complete = vi.fn();
    const { app, dependencies, repositories } = createTestApp({ chatInferencePipelineComplete: complete });
    const owner = await issueTestSession(app, "ownership-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: member.workspaceId, sourceChannel: "dashboard" });

    const takeover = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(member))
      .send({ reason: "VIP follow-up" });

    expect(takeover.status).toBe(200);
    expect(takeover.body.ownership).toMatchObject({
      conversationId: conversation.id,
      workspaceId: member.workspaceId,
      state: "human_owned",
      ownerAccountId: member.accountId,
      ownerUserId: member.userId,
      ownerDisplayName: "ownership-member@example.com",
      reason: "operator_takeover",
      version: 1,
    });
    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      accountId: member.accountId,
      workspaceId: member.workspaceId,
      eventType: "hitl.ownership",
      eventStatus: "success",
      metadata: expect.objectContaining({
        action: "taken_over",
        actorUserId: member.userId,
        conversationId: conversation.id,
        reason: "VIP follow-up",
      }),
    }));

    const publishedConversationEvents: unknown[] = [];
    const unsubscribeConversationEvents = dependencies.publicConversationEventBus.subscribe(conversation.id, (event) => {
      publishedConversationEvents.push(event);
    });
    const reply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(member))
      .send({ message: "Dana here. I can take this from here.", expectedVersion: 1 });
    unsubscribeConversationEvents();

    expect(reply.status).toBe(201);
    expect(reply.body.message).toMatchObject({
      conversationId: conversation.id,
      workspaceId: member.workspaceId,
      role: "assistant",
      source: "human_agent",
      content: "Dana here. I can take this from here.",
      metadata: {
        humanAgent: {
          accountId: member.accountId,
          userId: member.userId,
          displayName: "Ownership Owner Organization",
        },
      },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(publishedConversationEvents).toEqual([
      {
        type: "message.created",
        conversationId: conversation.id,
        workspaceId: member.workspaceId,
        messageId: reply.body.message.id,
        createdAt: reply.body.message.createdAt,
      },
    ]);
    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "hitl.ownership",
      metadata: expect.objectContaining({
        action: "replied",
        actorUserId: member.userId,
        conversationId: conversation.id,
        messageId: reply.body.message.id,
        messageLength: 37,
      }),
    }));

    const staleTransfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toUserId: owner.userId, expectedVersion: 0 });

    expect(staleTransfer.status).toBe(409);
    expect(staleTransfer.body.error.details.ownership).toMatchObject({
      conversationId: conversation.id,
      ownerUserId: member.userId,
      version: 1,
    });

    const publishInvalidation = vi.spyOn(dependencies.workspaceInvalidationPublisher, "enqueue");
    const transfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toUserId: owner.userId, expectedVersion: 1 });

    expect(transfer.status).toBe(200);
    expect(transfer.body.ownership).toMatchObject({
      state: "human_owned",
      ownerAccountId: member.accountId,
      ownerUserId: owner.userId,
      ownerDisplayName: "ownership-owner@example.com",
      version: 2,
    });
    expect(publishInvalidation).toHaveBeenCalledWith(member.workspaceId, ["conversation.ownership_changed"]);
    expect(repositories.auditEventRepository.items).toContainEqual(expect.objectContaining({
      eventType: "hitl.ownership",
      metadata: expect.objectContaining({
        action: "transferred",
        actorUserId: member.userId,
        targetUserId: owner.userId,
        conversationId: conversation.id,
      }),
    }));

    const handback = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/handback`)
      .set(adminSessionHeaders(owner))
      .send({ expectedVersion: 2 });

    expect(handback.status).toBe(200);
    expect(handback.body.ownership).toMatchObject({
      state: "ai_owned",
      ownerAccountId: null,
      ownerUserId: null,
      ownerDisplayName: null,
      version: 3,
    });

    const staleReply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(member))
      .send({ message: "Still here.", expectedVersion: 2 });

    expect(staleReply.status).toBe(409);
    expect(staleReply.body.error.details.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "ai_owned",
      version: 3,
    });

    expect(repositories.auditEventRepository.items.filter((event) =>
      event.eventType === "hitl.ownership" && event.metadata.conversationId === conversation.id
    ).map((event) => event.metadata.action)).toEqual([
      "taken_over",
      "replied",
      "transferred",
      "handed_back",
    ]);
    expect(dependencies.chatInferencePipeline.complete).not.toHaveBeenCalled();
  });

  it("refuses a reply and a hand-back from a teammate who does not own the conversation", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-guard-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-guard-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const claim = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(member))
      .send({});
    const version = claim.body.ownership.version as number;

    const reply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(owner))
      .send({ message: "Let me jump in.", expectedVersion: version });
    const handback = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/handback`)
      .set(adminSessionHeaders(owner))
      .send({ expectedVersion: version });

    for (const refused of [reply, handback]) {
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("conflict");
      expect(refused.body.error.details.ownership).toMatchObject({ state: "human_owned", ownerUserId: member.userId, version });
    }
    expect(await repositories.messageRepository.listByConversationId(owner.workspaceId, conversation.id)).toEqual([]);
    await expect(repositories.conversationOwnershipRepository.load(conversation.id))
      .resolves.toMatchObject({ state: "human_owned", ownerUserId: member.userId, version });
  });

  it("answers a committed take over, reply and hand back even when their audit records fail", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-audit-owner@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const auditEvents = repositories.auditEventRepository;
    const createAuditEvent = auditEvents.create.bind(auditEvents);
    vi.spyOn(auditEvents, "create").mockImplementation(async (event) =>
      event.eventType === "hitl.ownership" ? Promise.reject(new Error("audit unavailable")) : createAuditEvent(event));

    const takeover = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(owner))
      .send({});
    const reply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(owner))
      .send({ message: "On it.", expectedVersion: takeover.body.ownership?.version });
    const handback = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/handback`)
      .set(adminSessionHeaders(owner))
      .send({ expectedVersion: reply.body.ownership?.version });

    expect([takeover.status, reply.status, handback.status]).toEqual([200, 201, 200]);
    expect(handback.body.ownership).toMatchObject({ state: "ai_owned" });
    expect(await repositories.messageRepository.listByConversationId(owner.workspaceId, conversation.id)).toHaveLength(1);
  });

  it("claims a waiting handoff for the teammate who replies to it", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-claim-reply-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-claim-reply-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const requested = await repositories.conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: owner.workspaceId,
      reason: "routine_handoff",
    });

    const reply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(member))
      .send({ message: "Hi, I can help.", expectedVersion: requested.record.version });

    expect(reply.status).toBe(201);
    expect(reply.body.ownership).toMatchObject({ state: "human_owned", ownerUserId: member.userId, version: requested.record.version + 1 });
    expect(repositories.auditEventRepository.items.filter((event) =>
      event.eventType === "hitl.ownership" && event.metadata.conversationId === conversation.id
    ).map((event) => event.metadata.action)).toEqual(["taken_over", "replied"]);
  });

  it("gives two teammates of one organisation distinct owners and labels", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-pair-owner@example.com");
    const dana = await acceptInvite(app, owner.cookie, "ownership-pair-dana@example.com");
    const fox = await acceptInvite(app, owner.cookie, "ownership-pair-fox@example.com");
    await repositories.userRepository.updateDisplayName(dana.userId, "Dana Scully");
    const first = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const second = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });

    const danaClaim = await request(app)
      .post(`/api/v1/conversations/${first.id}/takeover`)
      .set(adminSessionHeaders(dana))
      .send({});
    const foxClaim = await request(app)
      .post(`/api/v1/conversations/${second.id}/takeover`)
      .set(adminSessionHeaders(fox))
      .send({});

    expect(dana.accountId).toBe(fox.accountId);
    expect(danaClaim.body.ownership).toMatchObject({ ownerUserId: dana.userId, ownerDisplayName: "Dana Scully" });
    expect(foxClaim.body.ownership).toMatchObject({ ownerUserId: fox.userId, ownerDisplayName: "ownership-pair-fox@example.com" });
  });

  it("signs a reply with the teammate's name, else the organisation's, and never with an email", async () => {
    const { app, dependencies, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-signature-owner@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const claim = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(owner))
      .send({});
    const version = claim.body.ownership.version as number;
    await dependencies.accountRepository.updateName(owner.accountId, "   ");

    const unsigned = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(owner))
      .send({ message: "First reply.", expectedVersion: version });
    await repositories.userRepository.updateDisplayName(owner.userId, "Dana Scully");
    const signed = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(owner))
      .send({ message: "Second reply.", expectedVersion: version });

    expect(unsigned.status).toBe(201);
    expect(unsigned.body.message.metadata.humanAgent).toEqual({ accountId: owner.accountId, userId: owner.userId });
    // The operator-facing ownership next to it names the owner by teammate label; the message never does.
    expect(JSON.stringify(unsigned.body.message)).not.toContain("ownership-signature-owner@example.com");
    expect(signed.body.message.metadata.humanAgent).toEqual({
      accountId: owner.accountId,
      userId: owner.userId,
      displayName: "Dana Scully",
    });
  });

  it("hands a conversation to a teammate and queues them a notice", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-handoff-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-handoff-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    await repositories.conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: owner.workspaceId,
      reason: "routine_handoff",
    });

    const assigned = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(owner))
      .send({ toUserId: member.userId, expectedVersion: 1 });

    expect(assigned.status).toBe(200);
    expect(assigned.body.ownership).toMatchObject({
      state: "human_owned",
      ownerUserId: member.userId,
      ownerDisplayName: "ownership-handoff-member@example.com",
      version: 2,
    });
    expect(assigned.body.ownership.takenOverAt).toEqual(expect.any(String));
    expect(repositories.actionOutbox.items).toEqual([expect.objectContaining({
      type: "conversation.transfer_notice",
      payload: { recipientUserId: member.userId, transferredByUserId: owner.userId, ownershipVersion: 2 },
      workspaceId: owner.workspaceId,
      conversationId: conversation.id,
      idempotencyKey: `conversation-transfer:${conversation.id}:2`,
    })]);
  });

  it("lets a teammate take a conversation over from another by transferring it to themselves, without a notice", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-self-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-self-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const claim = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(member))
      .send({});

    const snatch = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(owner))
      .send({});
    const takeFrom = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(owner))
      .send({ toUserId: owner.userId, expectedVersion: claim.body.ownership.version });

    expect(snatch.status).toBe(409);
    expect(takeFrom.status).toBe(200);
    expect(takeFrom.body.ownership).toMatchObject({ ownerUserId: owner.userId, version: claim.body.ownership.version + 1 });
    expect(repositories.actionOutbox.items).toEqual([]);
  });

  it("refuses to hand a conversation to anyone who is not a teammate on the workspace", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-foreign-owner@example.com");
    const stranger = await issueTestSession(app, "ownership-foreign-stranger@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const claim = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(owner))
      .send({});

    for (const toUserId of [stranger.userId, randomUUID()]) {
      const response = await request(app)
        .post(`/api/v1/conversations/${conversation.id}/transfer`)
        .set(adminSessionHeaders(owner))
        .send({ toUserId, expectedVersion: claim.body.ownership.version });

      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: "transfer_target_unavailable", message: "Transfer target not found" });
    }
    const missingConversation = await request(app)
      .post(`/api/v1/conversations/${randomUUID()}/transfer`)
      .set(adminSessionHeaders(owner))
      .send({ toUserId: owner.userId, expectedVersion: claim.body.ownership.version });
    expect(missingConversation.status).toBe(404);
    expect(missingConversation.body.error.code).toBe("not_found");
    const legacyBody = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(owner))
      .send({ toAccountId: owner.accountId, expectedVersion: claim.body.ownership.version });
    expect(legacyBody.status).toBe(400);
    expect(repositories.actionOutbox.items).toEqual([]);
  });

  it("leaves a disabled teammate off the operators list and refuses to hand them a conversation", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-disabled-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-disabled-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: owner.workspaceId, sourceChannel: "dashboard" });
    const claim = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(owner))
      .send({});
    repositories.userRepository.disable(member.userId);

    const operators = await request(app)
      .get("/api/v1/conversations/operators")
      .set(adminSessionHeaders(owner));
    const transfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(owner))
      .send({ toUserId: member.userId, expectedVersion: claim.body.ownership.version });

    expect(operators.body.operators).toEqual([{ userId: owner.userId, label: "ownership-disabled-owner@example.com" }]);
    expect(transfer.status).toBe(404);
    expect(transfer.body.error.code).toBe("transfer_target_unavailable");
    expect(repositories.actionOutbox.items).toEqual([]);
  });

  it("lists the teammates who can own a conversation, by teammate label", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-directory-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-directory-member@example.com");
    await issueTestSession(app, "ownership-directory-stranger@example.com");
    await repositories.userRepository.updateDisplayName(member.userId, "Fox Mulder");

    const response = await request(app)
      .get("/api/v1/conversations/operators")
      .set(adminSessionHeaders(member));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      operators: [
        { userId: owner.userId, label: "ownership-directory-owner@example.com" },
        { userId: member.userId, label: "Fox Mulder" },
      ],
    });
  });

  it("rejects callers without takeover permission before validating the body", async () => {
    const { app, dependencies, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-denied-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-denied-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: member.workspaceId, sourceChannel: "dashboard" });
    const permissionSpy = vi.spyOn(dependencies.accountAccessService, "requirePermission")
      .mockRejectedValueOnce(forbidden("No takeover"));

    const response = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(member))
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("No takeover");
    permissionSpy.mockRestore();
  });

  it("returns not found for a conversation in another workspace", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "ownership-local@example.com");
    const foreign = await issueTestSession(app, "ownership-foreign@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: foreign.workspaceId, sourceChannel: "dashboard" });

    const response = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(session))
      .send({});

    expect(response.status).toBe(404);
  });

  it("shows the operator each change in the conversation's timeline, and lists a handed-back handoff as recently closed", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "activity-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "activity-member@example.com");
    await repositories.userRepository.updateDisplayName(member.userId, "Bea");
    const conversation = await repositories.conversationRepository.create({ workspaceId: member.workspaceId, sourceChannel: "dashboard" });
    await repositories.conversationRepository.setTitle(conversation.id, member.workspaceId, "Refund for order 1042");
    const requested = await repositories.conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: member.workspaceId,
      reason: "routine_handoff",
    });

    const assigned = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toUserId: owner.userId, expectedVersion: requested.record.version });
    const retaken = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toUserId: member.userId, expectedVersion: assigned.body.ownership.version });
    const handedBack = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/handback`)
      .set(adminSessionHeaders(member))
      .send({ expectedVersion: retaken.body.ownership.version });
    expect([assigned.status, retaken.status, handedBack.status]).toEqual([200, 200, 200]);

    const detail = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}`)
      .set(adminSessionHeaders(member));
    const tail = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}/tail`)
      .set(adminSessionHeaders(member));

    const expected = [
      expect.objectContaining({
        kind: "reassigned",
        actor: { userId: member.userId, label: "Bea" },
        subject: { userId: owner.userId, label: "activity-owner@example.com" },
        from: null,
      }),
      expect.objectContaining({
        kind: "reassigned",
        actor: { userId: member.userId, label: "Bea" },
        subject: { userId: member.userId, label: "Bea" },
        from: { userId: owner.userId, label: "activity-owner@example.com" },
      }),
      expect.objectContaining({ kind: "handed_back", actor: { userId: member.userId, label: "Bea" } }),
    ];
    expect(detail.status).toBe(200);
    expect(detail.body.activity).toEqual(expected);
    expect(tail.status).toBe(200);
    expect(tail.body.activity).toEqual(expected);

    const closed = await request(app)
      .get("/api/v1/conversations/recently-closed")
      .set(adminSessionHeaders(member));

    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({
      items: [expect.objectContaining({
        conversationId: conversation.id,
        itemKind: "handoff",
        outcome: "handed_back",
        closedBy: { userId: member.userId, label: "Bea" },
        closedAt: expect.any(String),
        title: "Refund for order 1042",
      })],
    });
  });

  it("shows feedback triage outcomes in the activity and recently closed only to teammates with Quality access", async () => {
    const { app, repositories } = createTestApp();
    const owner = await issueTestSession(app, "activity-quality-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "activity-quality-member@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: member.workspaceId, sourceChannel: "dashboard" });
    const scope = { conversationId: conversation.id, workspaceId: member.workspaceId };
    await repositories.conversationActivity.record(undefined, { ...scope, kind: "handed_back", actorUserId: member.userId });
    await repositories.conversationActivity.record(undefined, {
      ...scope,
      kind: "feedback_resolved",
      actorUserId: owner.userId,
      detail: { assistantMessageId: randomUUID(), triageTransitionId: randomUUID(), resolution: "knowledge_gap" },
    });

    const read = async (session: { cookie: string; workspaceId: string }) => {
      const [detail, tail, closed] = await Promise.all([
        request(app).get(`/api/v1/history/chat/${conversation.id}`).set(adminSessionHeaders(session)),
        request(app).get(`/api/v1/history/chat/${conversation.id}/tail`).set(adminSessionHeaders(session)),
        request(app).get("/api/v1/conversations/recently-closed").set(adminSessionHeaders(session)),
      ]);
      expect([detail.status, tail.status, closed.status]).toEqual([200, 200, 200]);
      return {
        detail: (detail.body.activity as Array<{ kind: string }>).map((entry) => entry.kind),
        tail: (tail.body.activity as Array<{ kind: string }>).map((entry) => entry.kind),
        closed: (closed.body.items as Array<{ outcome: string }>).map((item) => item.outcome),
      };
    };

    // A member follows conversations but holds no Quality access, so triage outcomes stay out.
    await expect(read(member)).resolves.toEqual({
      detail: ["handed_back"],
      tail: ["handed_back"],
      closed: ["handed_back"],
    });
    await expect(read(owner)).resolves.toEqual({
      detail: ["handed_back", "feedback_resolved"],
      tail: ["handed_back", "feedback_resolved"],
      closed: ["feedback_resolved", "handed_back"],
    });
  });

  it("tails only the activity recorded since the caller's activity cursor", async () => {
    const { app, repositories } = createTestApp();
    const session = await issueTestSession(app, "activity-cursor@example.com");
    const conversation = await repositories.conversationRepository.create({ workspaceId: session.workspaceId, sourceChannel: "dashboard" });
    const scope = { conversationId: conversation.id, workspaceId: session.workspaceId };
    await repositories.conversationActivity.record(undefined, { ...scope, kind: "claimed", actorUserId: session.userId });

    const first = await request(app).get(`/api/v1/history/chat/${conversation.id}/tail`).set(adminSessionHeaders(session));
    await repositories.conversationActivity.record(undefined, { ...scope, kind: "handed_back", actorUserId: session.userId });
    const next = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}/tail?activityCursor=${first.body.activityCursor as string}`)
      .set(adminSessionHeaders(session));
    const invalid = await request(app)
      .get(`/api/v1/history/chat/${conversation.id}/tail?activityCursor=not-an-id`)
      .set(adminSessionHeaders(session));

    expect(first.body.activity).toEqual([expect.objectContaining({ kind: "claimed" })]);
    expect(first.body.activityCursor).toBe(first.body.activity[0].id);
    expect(next.body.activity).toEqual([expect.objectContaining({ kind: "handed_back" })]);
    expect(next.body.activityCursor).toBe(next.body.activity[0].id);
    expect(invalid.status).toBe(400);
  });

  it("keeps recently closed to teammates with takeover permission, and checks its limit", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "activity-denied@example.com");
    const permissionSpy = vi.spyOn(dependencies.accountAccessService, "requirePermission")
      .mockRejectedValueOnce(forbidden("No takeover"));

    const denied = await request(app).get("/api/v1/conversations/recently-closed").set(adminSessionHeaders(session));
    const invalid = await request(app).get("/api/v1/conversations/recently-closed?limit=500").set(adminSessionHeaders(session));

    expect(denied.status).toBe(403);
    expect(invalid.status).toBe(400);
    permissionSpy.mockRestore();
  });
});
