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
  VendorHeldConversationDataEraser,
  VendorHeldConversationDataErasure,
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
  /** The conversation's latest update or message; the epoch when a test does not care. */
  lastActivityAt?: Date;
}

/**
 * One in-memory "database" with transaction semantics: the work runs against a copy, which replaces
 * the committed state only when the work resolves.
 */
const createFake = (input: {
  conversations: FakeConversation[];
  visitors?: { id: string; workspaceId: string; verifiedCustomerId: string | null; visitorKey?: string | null }[];
  eraserRows?: Record<string, number>;
  customerEraserRows?: Record<string, number>;
  /** Fails the transaction once, as a deadlock victim does, before it commits. */
  failFirstRun?: boolean;
  vendorHeld?: boolean;
  /** The vendor-held read rejects, as one whose rows cannot be read does. */
  vendorReadFails?: boolean;
  /** An eraser rejects after the vendor-held read. */
  eraserFails?: string;
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
      if (input.eraserFails === owner) throw new Error(`${owner} failed`);
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

  const vendorPrepared: VendorHeldConversationDataErasure[] = [];
  const vendorErased: VendorHeldConversationDataErasure[] = [];
  const vendorHeldData: VendorHeldConversationDataEraser | undefined = input.vendorHeld
    ? {
      prepare: async (erasure) => {
        order.push("vendor:prepare");
        if (input.vendorReadFails) throw new Error("voice sessions could not be read");
        vendorPrepared.push(erasure);
        return { erase: async () => {
          order.push("vendor:erase");
          vendorErased.push(erasure);
        } };
      },
    }
    : undefined;
  let runs = 0;

  const unitOfWork = {
    async run<T>(work: (scope: ConversationErasureWriteScope) => Promise<T>): Promise<T> {
      runs += 1;
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
                visitorKey: visitor.visitorKey ?? null,
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
        async lockInactiveConversations(workspaceId, inactiveBefore, limit) {
          order.push("lockInactive");
          const inactive = draft.conversations
            .filter((conversation) => conversation.workspaceId === workspaceId
              && (conversation.lastActivityAt ?? new Date(0)).getTime() < inactiveBefore.getTime())
            .map((conversation) => conversation.id)
            .sort()
            .slice(0, limit);
          return { claimed: inactive.length, inactive };
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
        visitorKeyErasers: [{
          owner: "voice-channel",
          async eraseVisitorKey(scope) {
            order.push("visitorKey:voice-channel");
            customerScopes.push({ owner: "voice-channel", verifiedCustomerId: scope.visitorKey });
            return 1;
          },
        }],
        vendorHeldData: vendorHeldData ?? null,
        audit: { async record(event) { order.push("audit"); draft.audit.push(event); } },
      });
      if (input.failFirstRun && runs === 1) {
        order.push("rollback");
        return this.run(work);
      }
      order.push("commit");
      committed = draft;
      return result;
    },
  };
  const invalidation = { enqueue: vi.fn() };
  const auditLog = { logRecorded: vi.fn() };
  const service = new ConversationErasureService({ unitOfWork, invalidation, auditLog });
  return {
    service,
    vendorPrepared,
    vendorErased,
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
    expect(fake.order).toEqual(["lock", "erase:context-variables", "erase:audit", "deleteConversations", "audit", "commit"]);
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
      "commit",
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

describe("ConversationErasureService and what vendors hold", () => {
  it("reads what vendors hold before any eraser runs, and erases it only once the deletion committed", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-1", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 2 }],
      vendorHeld: true,
    });

    await fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR });

    expect(fake.order).toEqual(["lock", "vendor:prepare", "erase:context-variables", "erase:audit", "deleteConversations", "audit", "commit", "vendor:erase"]);
    expect(fake.vendorPrepared).toEqual([{
      account: { id: ACTOR.accountId, deleted: false },
      scopes: [{ kind: "conversations", workspaceId: WORKSPACE, conversationIds: ["conv-1"] }],
    }]);
  });

  it("erases what vendors hold for every conversation of an erased visitor", async () => {
    const fake = createFake({
      conversations: [
        { id: "conv-b", workspaceId: WORKSPACE, chatSessionId: null, visitorId: "visitor-1", messages: 1 },
        { id: "conv-a", workspaceId: WORKSPACE, chatSessionId: null, visitorId: "visitor-1", messages: 1 },
      ],
      visitors: [{ id: "visitor-1", workspaceId: WORKSPACE, verifiedCustomerId: null }],
      vendorHeld: true,
    });

    await fake.service.eraseVisitor({ workspaceId: WORKSPACE, visitorId: "visitor-1", actor: ACTOR });

    expect(fake.vendorErased.map((erasure) => erasure.scopes)).toEqual([[{ kind: "conversations", workspaceId: WORKSPACE, conversationIds: ["conv-b", "conv-a"] }]]);
  });

  it("reads what a visitor left by their key before any conversation, with no conversation at all, and erases it", async () => {
    const fake = createFake({
      conversations: [],
      visitors: [{ id: "visitor-1", workspaceId: WORKSPACE, verifiedCustomerId: null, visitorKey: "visitor-key-1" }],
      vendorHeld: true,
    });

    const receipt = await fake.service.eraseVisitor({ workspaceId: WORKSPACE, visitorId: "visitor-1", actor: ACTOR });

    expect(fake.vendorPrepared.map((erasure) => erasure.scopes)).toEqual([[{ kind: "visitor_key", workspaceId: WORKSPACE, visitorKey: "visitor-key-1" }]]);
    expect(fake.order).toEqual(["lockVisitor", "vendor:prepare", "visitorKey:voice-channel", "deleteVisitor", "audit", "commit", "vendor:erase"]);
    expect(receipt.rowsByOwner).toEqual({ "voice-channel": 1 });
  });

  it("fails the erasure, recording and asking the vendor nothing, when what vendors hold cannot be read", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-1", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1 }],
      vendorHeld: true,
      vendorReadFails: true,
    });

    await expect(fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR })).rejects.toThrow("voice sessions could not be read");

    expect(fake.state().conversations).toHaveLength(1);
    expect(fake.state().audit).toEqual([]);
    expect(fake.vendorErased).toEqual([]);
  });

  it("asks the vendor nothing when an eraser fails after the read", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-1", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1 }],
      vendorHeld: true,
      eraserFails: "audit",
    });

    await expect(fake.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR })).rejects.toThrow("audit failed");

    expect(fake.vendorPrepared).toHaveLength(1);
    expect(fake.vendorErased).toEqual([]);
    expect(fake.state().conversations).toHaveLength(1);
  });

  it("asks the vendors nothing for an erasure that was refused, and only once for one that ran again", async () => {
    const refused = createFake({ conversations: [], vendorHeld: true });
    await expect(refused.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-missing", actor: ACTOR })).rejects.toThrow();
    expect(refused.vendorErased).toEqual([]);

    const retried = createFake({
      conversations: [{ id: "conv-1", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1 }],
      vendorHeld: true,
      failFirstRun: true,
    });
    await retried.service.eraseConversation({ workspaceId: WORKSPACE, conversationId: "conv-1", actor: ACTOR });
    expect(retried.vendorPrepared).toHaveLength(2);
    expect(retried.vendorErased).toHaveLength(1);
  });
});

describe("ConversationErasureService.eraseInactiveConversations", () => {
  const CUTOFF = new Date("2026-07-01T00:00:00.000Z");
  const retention = { workspaceId: WORKSPACE, accountId: "acct-1", inactiveBefore: CUTOFF, retentionDays: 90 };

  it("erases the conversations inactive since the cutoff through every eraser, and records the schedule's act with counts only", async () => {
    const fake = createFake({
      conversations: [
        { id: "conv-old", workspaceId: WORKSPACE, chatSessionId: "session-1", visitorId: null, messages: 3, lastActivityAt: new Date("2026-06-01T00:00:00.000Z") },
        { id: "conv-new", workspaceId: WORKSPACE, chatSessionId: "session-2", visitorId: null, messages: 2, lastActivityAt: new Date("2026-07-02T00:00:00.000Z") },
      ],
      eraserRows: { "context-variables": 1, audit: 2 },
    });

    const receipt = await fake.service.eraseInactiveConversations({ ...retention, limit: 10 });

    expect(receipt).toEqual({ conversationCount: 1, messageCount: 3, rowsByOwner: { "context-variables": 1, audit: 2 }, claimedCount: 1 });
    expect(fake.order).toEqual(["lockInactive", "erase:context-variables", "erase:audit", "deleteConversations", "audit", "commit"]);
    expect(fake.state().conversations.map((conversation) => conversation.id)).toEqual(["conv-new"]);
    expect(fake.state().audit).toEqual([{
      accountId: "acct-1",
      workspaceId: WORKSPACE,
      eventType: "conversation.retention.enforced",
      eventStatus: "success",
      metadata: {
        principalType: "system",
        retentionDays: 90,
        cutoff: CUTOFF.toISOString(),
        conversationCount: 1,
        messageCount: 3,
        rowsByOwner: { "context-variables": 1, audit: 2 },
      },
    }]);
    expect(JSON.stringify(fake.state().audit)).not.toContain("conv-old");
    expect(fake.invalidation.enqueue).toHaveBeenCalledWith(WORKSPACE, ["conversation.deleted"]);
  });

  it("erases at most the batch it was given", async () => {
    const fake = createFake({
      conversations: ["conv-a", "conv-b", "conv-c"].map((id) => ({ id, workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1 })),
    });

    const receipt = await fake.service.eraseInactiveConversations({ ...retention, limit: 2 });

    expect(receipt.conversationCount).toBe(2);
    expect(fake.state().conversations.map((conversation) => conversation.id)).toEqual(["conv-c"]);
  });

  it("records nothing and tells no dashboard when nothing is past the window", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-new", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1, lastActivityAt: new Date("2026-08-01T00:00:00.000Z") }],
    });

    const receipt = await fake.service.eraseInactiveConversations({ ...retention, limit: 10 });

    expect(receipt).toEqual({ conversationCount: 0, messageCount: 0, rowsByOwner: {}, claimedCount: 0 });
    expect(fake.order).toEqual(["lockInactive", "commit"]);
    expect(fake.state().audit).toEqual([]);
    expect(fake.invalidation.enqueue).not.toHaveBeenCalled();
    expect(fake.auditLog.logRecorded).not.toHaveBeenCalled();
  });

  it("erases what vendors hold for the expired conversations once the deletion committed", async () => {
    const fake = createFake({
      conversations: [{ id: "conv-old", workspaceId: WORKSPACE, chatSessionId: null, visitorId: null, messages: 1 }],
      vendorHeld: true,
    });

    await fake.service.eraseInactiveConversations({ ...retention, limit: 10 });

    expect(fake.vendorPrepared).toEqual([{
      account: { id: "acct-1", deleted: false },
      scopes: [{ kind: "conversations", workspaceId: WORKSPACE, conversationIds: ["conv-old"] }],
    }]);
    expect(fake.order.indexOf("vendor:prepare")).toBeLessThan(fake.order.indexOf("erase:context-variables"));
    expect(fake.order.at(-1)).toBe("vendor:erase");
  });
});
