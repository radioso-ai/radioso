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
    cookie: login.headers["set-cookie"][0] as string,
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
    const transferTarget = await issueTestSession(app, "ownership-transfer-target@example.com");
    const conversation = await repositories.conversationRepository.create(member.workspaceId, null, "dashboard");

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
      ownerDisplayName: "Ownership Owner Organization",
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
        conversationId: conversation.id,
        messageId: reply.body.message.id,
        messageLength: 37,
      }),
    }));

    const staleTransfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toAccountId: member.accountId, expectedVersion: 0 });

    expect(staleTransfer.status).toBe(409);
    expect(staleTransfer.body.error.details.ownership).toMatchObject({
      conversationId: conversation.id,
      ownerAccountId: member.accountId,
      version: 1,
    });

    const foreignTransfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toAccountId: transferTarget.accountId, expectedVersion: 1 });

    expect(foreignTransfer.status).toBe(404);
    expect(foreignTransfer.body.error.message).toBe("Transfer target not found");

    const publishInvalidation = vi.spyOn(dependencies.workspaceInvalidationPublisher, "enqueue");
    const transfer = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/transfer`)
      .set(adminSessionHeaders(member))
      .send({ toAccountId: owner.accountId, expectedVersion: 1 });

    expect(transfer.status).toBe(200);
    expect(transfer.body.ownership).toMatchObject({
      state: "human_owned",
      ownerAccountId: owner.accountId,
      ownerDisplayName: "Ownership Owner Organization",
      version: 1,
    });
    expect(publishInvalidation).not.toHaveBeenCalled();

    const handback = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/handback`)
      .set(adminSessionHeaders(member))
      .send({ expectedVersion: 1 });

    expect(handback.status).toBe(200);
    expect(handback.body.ownership).toMatchObject({
      state: "ai_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      version: 2,
    });

    const staleReply = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/reply`)
      .set(adminSessionHeaders(member))
      .send({ message: "Still here.", expectedVersion: 2 });

    expect(staleReply.status).toBe(409);
    expect(staleReply.body.error.details.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "ai_owned",
      version: 2,
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

  it("rejects callers without takeover permission before validating the body", async () => {
    const { app, dependencies, repositories } = createTestApp();
    const owner = await issueTestSession(app, "ownership-denied-owner@example.com");
    const member = await acceptInvite(app, owner.cookie, "ownership-denied-member@example.com");
    const conversation = await repositories.conversationRepository.create(member.workspaceId, null, "dashboard");
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
    const conversation = await repositories.conversationRepository.create(foreign.workspaceId, null, "dashboard");

    const response = await request(app)
      .post(`/api/v1/conversations/${conversation.id}/takeover`)
      .set(adminSessionHeaders(session))
      .send({});

    expect(response.status).toBe(404);
  });
});
