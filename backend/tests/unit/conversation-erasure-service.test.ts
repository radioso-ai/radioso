import { describe, expect, it, vi } from "vitest";

import {
  ConversationErasureService,
  type ConversationErasureWriteScope,
  type ErasureSubjects,
} from "../../src/modules/privacy/public.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import type {
  ConversationDataEraser,
  ConversationErasureScope,
  VerifiedCustomerDataEraser,
} from "../../src/shared/domain/conversationDataErasure.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const ACTOR = { accountId: "acct-1", userId: "user-1" };

interface FakeConversation {
  id: string;
  workspaceId: string;
  chatSessionId: string | null;
  visitorId: string | null;
  messages: number;
}

/**
 * One in-memory "database" with transaction semantics: the work runs against a copy, which replaces
 * the committed state only when the work resolves.
 */
const createFake = (input: {
  conversations: FakeConversation[];
  visitors?: { id: string; workspaceId: string; verifiedCustomerId: string | null }[];
  eraserRows?: Record<string, number>;
  customerEraserRows?: Record<string, number>;
}) => {
  let committed = {
    conversations: input.conversations.map((conversation) => ({ ...conversation })),
    visitors: (input.visitors ?? []).map((visitor) => ({ ...visitor })),
    audit: [] as AuditEventInput[],
  };
  const order: string[] = [];
  const eraserScopes: { owner: string; scope: ConversationErasureScope }[] = [];
  const customerScopes: { owner: string; verifiedCustomerId: string }[] = [];

  const conversationEraser = (owner: string): ConversationDataEraser => ({
    owner,
    async erase(scope) {
      order.push(`erase:${owner}`);
      eraserScopes.push({ owner, scope });
      return input.eraserRows?.[owner] ?? 0;
    },
  });
  const customerEraser = (owner: string): VerifiedCustomerDataEraser => ({
    owner,
    async eraseVerifiedCustomer(scope) {
      order.push(`customer:${owner}`);
      customerScopes.push({ owner, verifiedCustomerId: scope.verifiedCustomerId });
      return input.customerEraserRows?.[owner] ?? 0;
    },
  });

  const unitOfWork = {
    async run<T>(work: (scope: ConversationErasureWriteScope) => Promise<T>): Promise<T> {
      const draft = {
        conversations: committed.conversations.map((conversation) => ({ ...conversation })),
        visitors: committed.visitors.map((visitor) => ({ ...visitor })),
        audit: [...committed.audit],
      };
      const subjects: ErasureSubjects = {
        async lockConversations(workspaceId, conversationIds) {
          order.push("lock");
          return new Set(draft.conversations
            .filter((conversation) => conversation.workspaceId === workspaceId && conversationIds.includes(conversation.id))
            .map((conversation) => conversation.id));
        },
        async lockVisitor(workspaceId, visitorId) {
          order.push("lockVisitor");
          const visitor = draft.visitors.find((row) => row.id === visitorId && row.workspaceId === workspaceId);
          return visitor
            ? {
                verifiedCustomerId: visitor.verifiedCustomerId,
                conversationIds: draft.conversations.filter((conversation) => conversation.visitorId === visitorId).map((conversation) => conversation.id),
              }
            : null;
        },
        async deleteConversations(workspaceId, conversationIds) {
          order.push("deleteConversations");
          const doomed = draft.conversations.filter((conversation) => conversation.workspaceId === workspaceId && conversationIds.includes(conversation.id));
          draft.conversations = draft.conversations.filter((conversation) => !doomed.includes(conversation));
          return { conversations: doomed.length, messages: doomed.reduce((sum, conversation) => sum + conversation.messages, 0) };
        },
        async deleteVisitor(workspaceId, visitorId) {
          order.push("deleteVisitor");
          draft.visitors = draft.visitors.filter((visitor) => !(visitor.id === visitorId && visitor.workspaceId === workspaceId));
        },
      };
      const result = await work({
        subjects,
        conversationErasers: [conversationEraser("context-variables"), conversationEraser("audit")],
        verifiedCustomerErasers: [customerEraser("context-variables")],
        audit: { async record(event) { order.push("audit"); draft.audit.push(event); } },
      });
      committed = draft;
      return result;
    },
  };
  const invalidation = { enqueue: vi.fn() };
  const auditLog = { logRecorded: vi.fn() };
  const service = new ConversationErasureService({ unitOfWork, invalidation, auditLog });
  return {
    service,
    invalidation,
    auditLog,
    order,
    eraserScopes,
    customerScopes,
    state: () => committed,
  };
};

describe("ConversationErasureService.eraseConversation", () => {
  it("runs every eraser, then deletes the conversation, then records one content-free audit event", async () => {
    const fake = createFake({
      conversations: [
        { id: "conv-1", workspaceId: WORKSPACE, chatSessionId: "session-1", visitorId: null, messages: 4 },
        { id: "conv-2", workspaceId: WORKSPACE, chatSessionId: "session-2", visitorId: null, messages: 2 },
      ],
      eraserRows: { "context-variables": 1, audit: 3 },
    });

    const receipt = await fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR });

    expect(receipt).toEqual({
      conversationCount: 1,
      messageCount: 4,
      rowsByOwner: { "context-variables": 1, audit: 3 },
    });
    expect(fake.order).toEqual(["lock", "erase:context-variables", "erase:audit", "deleteConversations", "audit"]);
    expect(fake.eraserScopes.map(({ scope }) => scope)).toEqual([
      { kind: "conversations", workspaceId: WORKSPACE, conversationIds: ["conv-1"] },
      { kind: "conversations", workspaceId: WORKSPACE, conversationIds: ["conv-1"] },
    ]);
    expect(fake.state().conversations.map((conversation) => conversation.id)).toEqual(["conv-2"]);
    expect(fake.state().audit).toEqual([{
      accountId: ACTOR.accountId,
      workspaceId: WORKSPACE,
      eventType: "conversation.erased",
      eventStatus: "success",
      metadata: {
        actorUserId: ACTOR.userId,
        conversationId: "conv-1",
        conversationCount: 1,
        messageCount: 4,
        rowsByOwner: { "context-variables": 1, audit: 3 },
      },
    }]);
  });

  it("publishes the deletion to live dashboards and logs the audit event, both only after commit", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-1", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 0 }],
    });

    await fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR });

    expect(fake.invalidation.enqueue).toHaveBeenCalledWith(WORKSPACE, ["conversation.deleted"]);
    expect(fake.auditLog.logRecorded).toHaveBeenCalledWith(expect.objectContaining({ eventType: "conversation.erased" }));
  });

  it("refuses a conversation outside the workspace as not found, erasing and recording nothing", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-1", workspaceId: "22222222-2222-4222-8222-222222222222", chatSessionId: null, visitorId: null, messages: 3 }],
    });

    await expect(fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(fake.order).toEqual(["lock"]);
    expect(fake.state().conversations).toHaveLength(1);
    expect(fake.state().audit).toEqual([]);
    expect(fake.invalidation.enqueue).not.toHaveBeenCalled();
    expect(fake.auditLog.logRecorded).not.toHaveBeenCalled();
  });
});

describe("ConversationErasureService.eraseVisitor", () => {
  it("erases every conversation of the visitor, then the verified customer's data, then the visitor row", async () => {
    const fake = createFake({
      conversations: [
        { id: "conv-a", workspaceId: WORKSPACE, chatSessionId: "session-a", visitorId: "visitor-1", messages: 2 },
        { id: "conv-b", workspaceId: WORKSPACE, chatSessionId: "session-b", visitorId: "visitor-1", messages: 5 },
        { id: "conv-other", workspaceId: WORKSPACE, chatSessionId: "session-c", visitorId: "visitor-2", messages: 1 },
      ],
      visitors: [
        { id: "visitor-1", workspaceId: WORKSPACE, verifiedCustomerId: "customer-42" },
        { id: "visitor-2", workspaceId: WORKSPACE, verifiedCustomerId: null },
      ],
      eraserRows: { "context-variables": 2 },
      customerEraserRows: { "context-variables": 1 },
    });

    const receipt = await fake.service.eraseVisitor({ workspaceId: WORKSPACE, visitorId: "visitor-1", actor: ACTOR });

    expect(receipt).toEqual({
      conversationCount: 2,
      messageCount: 7,
      rowsByOwner: { "context-variables": 3, audit: 0 },
    });
    expect(fake.order).toEqual([
      "lockVisitor",
      "lock",
      "erase:context-variables",
      "erase:audit",
      "deleteConversations",
      "customer:context-variables",
      "deleteVisitor",
      "audit",
    ]);
    expect(fake.eraserScopes[0]?.scope).toEqual({
      kind: "conversations",
      workspaceId: WORKSPACE,
      conversationIds: ["conv-a", "conv-b"],
    });
    expect(fake.customerScopes).toEqual([{ owner: "context-variables", verifiedCustomerId: "customer-42" }]);
    expect(fake.state().conversations.map((conversation) => conversation.id)).toEqual(["conv-other"]);
    expect(fake.state().visitors.map((visitor) => visitor.id)).toEqual(["visitor-2"]);
    expect(fake.state().audit).toEqual([expect.objectContaining({
      eventType: "visitor.erased",
      metadata: {
        actorUserId: ACTOR.userId,
        visitorId: "visitor-1",
        conversationCount: 2,
        messageCount: 7,
        rowsByOwner: { "context-variables": 3, audit: 0 },
      },
    })]);
    expect(fake.invalidation.enqueue).toHaveBeenCalledWith(WORKSPACE, ["conversation.deleted"]);
  });

  it("removes a visitor without a verified customer id and without conversations, skipping customer erasers", async () => {
    const fake = createFake({
      conversations: [],
      visitors: [{ id: "visitor-1", workspaceId: WORKSPACE, verifiedCustomerId: null }],
    });

    const receipt = await fake.service.eraseVisitor({ workspaceId: WORKSPACE, visitorId: "visitor-1", actor: ACTOR });

    expect(receipt.conversationCount).toBe(0);
    expect(fake.customerScopes).toEqual([]);
    expect(fake.eraserScopes).toEqual([]);
    expect(fake.state().visitors).toEqual([]);
    expect(fake.invalidation.enqueue).not.toHaveBeenCalled();
  });

  it("refuses an unknown visitor as not found, recording nothing", async () => {
    const fake = createFake({ conversations: [] });

    await expect(fake.service.eraseVisitor({ workspaceId: WORKSPACE, visitorId: "missing", actor: ACTOR }))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(fake.state().audit).toEqual([]);
    expect(fake.auditLog.logRecorded).not.toHaveBeenCalled();
  });
});
