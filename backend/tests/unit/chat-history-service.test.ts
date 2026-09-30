import { describe, expect, it } from "vitest";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { createConversationActivityComposition } from "../../src/app/composition/conversationActivity.js";
import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type {
  AnswerCoverageReactionTrace,
  AnswerCoverageRecord,
} from "../../src/modules/answerCoverage/public.js";
import type { AnswerCoverageHistoryReader } from "../../src/modules/chat/services/answerCoverageHistoryProvider.js";
import type {
  ContactHistoryDetail,
  ContactHistoryProviderPort,
  ContactHistorySummary,
} from "../../src/modules/chat/services/contactHistoryProvider.js";
import type { VisitorRecord } from "../../src/db/repositories/visitorRepository.js";
import {
  InMemoryAuditEventRepository,
  InMemoryConversationActivityStore,
  InMemoryConversationOwnershipRepository,
  InMemoryConversationRepository,
  InMemoryHistoryItemsRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

/** Minimal fake of the narrow `VisitorProfileReaderPort` chat/history depends on (spec 1277). */
class InMemoryVisitorProfileReader {
  readonly visitors = new Map<string, VisitorRecord>();

  async findById(workspaceId: string, visitorId: string): Promise<VisitorRecord | null> {
    const record = this.visitors.get(visitorId);
    return record && record.workspaceId === workspaceId ? record : null;
  }
}

/** Fake of the narrow teammate-label port: labels by user id, counting each batched read. */
class RecordingTeammateLabelReader {
  readonly labels = new Map<string, string>();
  readonly reads: string[][] = [];

  async labelsByUserIds(userIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    this.reads.push([...userIds]);
    return new Map(userIds.flatMap((userId) => {
      const label = this.labels.get(userId);
      return label === undefined ? [] : [[userId, label] as const];
    }));
  }
}

const createService = (
  visitorRepository: InMemoryVisitorProfileReader = new InMemoryVisitorProfileReader(),
  teammateLabels: RecordingTeammateLabelReader = new RecordingTeammateLabelReader(),
) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const auditRepository = new InMemoryAuditEventRepository();
  const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
  const conversationOwnershipRepository = new InMemoryConversationOwnershipRepository();
  return {
    conversationRepository,
    messageRepository,
    auditRepository,
    conversationOwnershipRepository,
    visitorRepository,
    teammateLabels,
    service: new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      historyItemsRepository,
      undefined,
      undefined,
      conversationOwnershipRepository,
      undefined,
      visitorRepository,
      teammateLabels,
    ),
  };
};

const buildVisitor = (overrides: Partial<VisitorRecord> = {}): VisitorRecord => ({
  id: "77777777-7777-4777-8777-777777777777",
  workspaceId: "workspace-1",
  visitorKey: "visitor-key-1",
  verifiedCustomerId: null,
  firstSeenAt: new Date("2026-05-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-05-02T00:00:00.000Z"),
  conversationCount: 2,
  lastCountry: "US",
  lastLanguage: "en",
  lastUserAgent: "Mozilla/5.0",
  createdAt: new Date("2026-05-01T00:00:00.000Z"),
  updatedAt: new Date("2026-05-02T00:00:00.000Z"),
  ...overrides,
});

class InMemoryContactHistoryProvider implements ContactHistoryProviderPort {
  readonly contacts: ContactHistoryDetail[] = [];

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ) {
    const offset = input.offset ?? 0;
    const page = this.contacts
      .filter((contact) => contact.workspaceId === workspaceId)
      .sort((left, right) => {
        const timeDiff = new Date(right.sortAt).getTime() - new Date(left.sortAt).getTime();
        return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
      });
    const contacts: ContactHistorySummary[] = page.slice(offset, offset + input.limit).map((contact) => ({
      ...contact,
      messagePreview: contact.messagePreview,
    }));

    return {
      contacts,
      total: page.length,
      nextCursor: null,
      hasMore: offset + contacts.length < page.length,
    };
  }

  async getById(workspaceId: string, requestId: string) {
    return this.contacts.find((contact) => contact.workspaceId === workspaceId && contact.id === requestId) ?? null;
  }
}

class InMemoryAnswerCoverageHistoryReader implements AnswerCoverageHistoryReader {
  readonly assessments = new Map<string, AnswerCoverageRecord>();
  readonly reactions = new Map<string, AnswerCoverageReactionTrace[]>();
  assessmentReads = 0;
  reactionReads = 0;

  async listByRequestMessageIds(input: { requestMessageIds: readonly string[] }) {
    this.assessmentReads += 1;
    return new Map(input.requestMessageIds.flatMap((id) => {
      const record = this.assessments.get(id);
      return record ? [[id, record] as const] : [];
    }));
  }

  async listByAssessmentIds(input: { assessmentIds: readonly string[] }) {
    this.reactionReads += 1;
    return new Map(input.assessmentIds.flatMap((id) => {
      const records = this.reactions.get(id);
      return records ? [[id, records] as const] : [];
    }));
  }
}

describe("chat history service ownership read surface", () => {
  const detailInput = { limit: 50, offset: 0 };

  it("includes ownership in detail when human-owned and includeOwnership is set (dashboard)", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      reason: "routine_handoff",
    });
    await conversationOwnershipRepository.takeOver({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      accountId: "operator-1",
      userId: "user-1",
      displayName: "Operator One",
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeOwnership: true,
    });

    expect(detail.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "human_owned",
      ownerAccountId: "operator-1",
      ownerUserId: "user-1",
      ownerDisplayName: "Operator One",
    });
    expect(typeof detail.ownership?.takenOverAt).toBe("string");
  });

  it("omits ownership from detail when includeOwnership is unset, even if human-owned (public surface)", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      reason: "routine_handoff",
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput);

    expect(detail.ownership).toBeUndefined();
  });

  it("omits turn latency unless the caller opts in", async () => {
    // The public/embed chat surface shares this read method, and its presenter forwards
    // unrecognised fields, so anything added unconditionally to the turn mapper silently becomes
    // public API without an OpenAPI or SDK change. Latency is an operator diagnostic.
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      role: "user",
      content: "hello",
    });

    const publicRead = await service.getConversation("workspace-1", conversation.id, detailInput);
    expect(publicRead.messages[0]).not.toHaveProperty("latencyMs");

    const operatorRead = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeLatency: true,
    });
    expect(operatorRead.messages[0]).toHaveProperty("latencyMs");
  });

  it("omits ownership from detail when the conversation is AI-owned (no row)", async () => {
    const { conversationRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeOwnership: true,
    });

    expect(detail.ownership).toBeUndefined();
  });

  it("carries the AI-owned record after a hand-back on operator detail reads, never on the public one", async () => {
    // The same rule as the tail: a pane that loads the detail after a hand-back must see the
    // hand-back's version, or a stale human-owned record from an earlier tail poll would win.
    const { conversationRepository, conversationOwnershipRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const message = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "hello",
    });
    await conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      reason: "routine_handoff",
    });
    const claimed = await conversationOwnershipRepository.takeOver({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      accountId: "operator-1",
      userId: "user-1",
      displayName: "Operator One",
    });
    if (!claimed.ok) {
      throw new Error("expected takeover to succeed");
    }
    const handedBack = await conversationOwnershipRepository.handBack({
      conversationId: conversation.id,
      expectedVersion: claimed.record.version,
      actingUserId: claimed.record.ownerUserId!,
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeOwnership: true,
    });
    const turn = await service.getConversationTurn("workspace-1", message.id, { includeOwnership: true });
    const publicDetail = await service.getConversation("workspace-1", conversation.id, detailInput);
    const publicTurn = await service.getConversationTurn("workspace-1", message.id);

    expect(detail.ownership).toMatchObject({ state: "ai_owned", ownerUserId: null, version: handedBack.record!.version });
    expect(turn.ownership).toMatchObject({ state: "ai_owned", version: handedBack.record!.version });
    expect(publicDetail).not.toHaveProperty("ownership");
    expect(publicTurn).not.toHaveProperty("ownership");
  });

  it("returns a tail cursor for the newest message in the detail snapshot", async () => {
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const first = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "first",
    });
    const latest = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "latest",
    });

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 1 });

    expect(detail.messages.map((message) => message.id)).toEqual([latest.id]);
    expect(detail.tailCursor).toBe(messageRepository.cursorFor(latest));
    expect(detail.tailCursor).not.toBe(messageRepository.cursorFor(first));
  });

  it("includes ownership per row in the conversation list, omitting AI-owned ones", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const human = await conversationRepository.create({ workspaceId: "workspace-1" });
    const ai = await conversationRepository.create({ workspaceId: "workspace-1" });
    await conversationOwnershipRepository.requestHandoff({
      conversationId: human.id,
      workspaceId: "workspace-1",
      reason: "retrieval_miss",
    });

    const page = await service.listConversations("workspace-1", { limit: 50, offset: 0 });
    const humanRow = page.conversations.find((row) => row.id === human.id);
    const aiRow = page.conversations.find((row) => row.id === ai.id);

    expect(humanRow?.ownership).toMatchObject({ state: "human_owned", reason: "retrieval_miss" });
    expect(aiRow?.ownership).toBeUndefined();
  });

  it("passes the human-owned ownership scope through to the conversation page", async () => {
    const { conversationRepository, service } = createService();
    const requestedInputs: unknown[] = [];
    const listPageByWorkspaceId = conversationRepository.listPageByWorkspaceId.bind(conversationRepository);
    conversationRepository.listPageByWorkspaceId = async (workspaceId, input) => {
      requestedInputs.push(input);
      return listPageByWorkspaceId(workspaceId, input);
    };

    await service.listConversations("workspace-1", {
      limit: 1,
      ownership: "human_owned",
    });

    expect(requestedInputs).toEqual([
      expect.objectContaining({ ownership: "human_owned" }),
    ]);
  });

  it("projects persisted channel context into list and detail responses", async () => {
    const { conversationRepository, service } = createService();
    const slackContext = {
      provider: "slack",
      team: { id: "T123", name: "Ausalt" },
      channel: { id: "D123", type: "im" },
      threadTs: "1712345678.000100",
      user: { id: "U123", displayName: "Dana" },
    } satisfies ConversationChannelContext;
    const slackConversation = await conversationRepository.create({
      workspaceId: "workspace-1",
      sourceChannel: "authenticated_chat",
      channelContext: slackContext,
    });
    const webConversation = await conversationRepository.create({
      workspaceId: "workspace-1",
      sourceChannel: "authenticated_chat",
    });

    const list = await service.listConversations("workspace-1", { limit: 50, offset: 0 });
    const items = await service.listItems("workspace-1", { limit: 50, offset: 0 });
    const slackRow = list.conversations.find((row) => row.id === slackConversation.id);
    const webRow = list.conversations.find((row) => row.id === webConversation.id);
    const slackItem = items.items.find((item) => item.kind === "chat" && item.conversation.id === slackConversation.id);
    const slackDetail = await service.getConversation("workspace-1", slackConversation.id, detailInput);
    const webDetail = await service.getConversation("workspace-1", webConversation.id, detailInput);

    expect(slackRow?.channelContext).toEqual(slackContext);
    expect(slackItem?.kind === "chat" ? slackItem.conversation.channelContext : null).toEqual(slackContext);
    expect(slackDetail.channelContext).toEqual(slackContext);
    expect(webRow?.channelContext).toBeNull();
    expect(webDetail.channelContext).toBeNull();
  });

  it("keeps contact requests in a human-caller feed and drops them only for agent callers", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
    const contactHistoryProvider = new InMemoryContactHistoryProvider();
    const service = new ChatHistoryService(
      conversationRepository, messageRepository, auditRepository, historyItemsRepository, contactHistoryProvider,
    );
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1", sourceChannel: "website_embed" });
    contactHistoryProvider.contacts.push({
      id: "66666666-6666-4666-8666-666666666666",
      sortAt: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      assistantMessageId: null,
      sourceChannel: "website_embed",
      sourceOrigin: "https://example.com/help",
      userEmail: "customer@example.com",
      messagePreview: "Please contact me about billing.",
      message: "Please contact me about billing.",
      triggerSource: "manual",
      triggerReason: null,
      status: "pending",
      attempts: 0,
      finalDeliveryError: null,
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    } as never);

    const humans = await service.listItems("workspace-1", { limit: 50, offset: 0, callerKind: "human" });
    const agents = await service.listItems("workspace-1", { limit: 50, offset: 0, callerKind: "agent" });

    // A contact request is filled in by a person, so asking for human callers still returns one.
    // No agent fills in a contact form, so asking for agent callers genuinely cannot.
    expect(humans.items.some((item) => item.kind === "contact")).toBe(true);
    expect(agents.items.some((item) => item.kind === "contact")).toBe(false);
  });

  it("projects the generated conversation title into list, items, and detail responses, defaulting to null", async () => {
    const { conversationRepository, service } = createService();
    const titled = await conversationRepository.create({ workspaceId: "workspace-1" });
    await conversationRepository.setTitle(titled.id, "workspace-1", "Refund for order 4821");
    const untitled = await conversationRepository.create({ workspaceId: "workspace-1" });

    const list = await service.listConversations("workspace-1", { limit: 50, offset: 0 });
    const items = await service.listItems("workspace-1", { limit: 50, offset: 0 });
    const titledRow = list.conversations.find((row) => row.id === titled.id);
    const untitledRow = list.conversations.find((row) => row.id === untitled.id);
    const titledItem = items.items.find((item) => item.kind === "chat" && item.conversation.id === titled.id);
    const titledDetail = await service.getConversation("workspace-1", titled.id, detailInput);
    const untitledDetail = await service.getConversation("workspace-1", untitled.id, detailInput);

    expect(titledRow?.title).toBe("Refund for order 4821");
    expect(untitledRow?.title).toBeNull();
    expect(titledItem?.kind === "chat" ? titledItem.conversation.title : null).toBe("Refund for order 4821");
    expect(titledDetail.title).toBe("Refund for order 4821");
    expect(untitledDetail.title).toBeNull();
  });

  it("tails dashboard messages with the ownership record, including an AI-owned one after a hand-back", async () => {
    const { conversationRepository, messageRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const baseline = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "baseline",
    });
    const first = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "human reply",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "ai_agent",
      content: "ai reply",
    });
    const claimed = await conversationOwnershipRepository.takeOver({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      accountId: "operator-1",
      userId: "user-1",
      displayName: "Operator One",
    });
    if (!claimed.ok) {
      throw new Error("expected takeover to succeed");
    }

    const tail = await service.tailConversation(
      "workspace-1",
      conversation.id,
      {
        cursor: messageRepository.cursorFor(baseline),
        limit: 1,
      },
      { includeOwnership: true },
    );

    expect(tail.messages).toEqual([
      expect.objectContaining({
        id: first.id,
        role: "assistant",
        source: "human_agent",
        content: "human reply",
      }),
    ]);
    expect(tail.cursor).toBe(messageRepository.cursorFor(first));
    expect(tail.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "human_owned",
      ownerAccountId: "operator-1",
      ownerDisplayName: "Operator One",
    });

    await conversationOwnershipRepository.handBack({
      conversationId: conversation.id,
      expectedVersion: claimed.record.version,
      actingUserId: claimed.record.ownerUserId!,
    });
    const aiOwnedTail = await service.tailConversation(
      "workspace-1",
      conversation.id,
      { cursor: tail.cursor!, limit: 10 },
      { includeOwnership: true },
    );

    // A hand-back made elsewhere reaches an open pane: the record comes back AI-owned at a newer version.
    expect(aiOwnedTail.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "ai_owned",
      ownerUserId: null,
      ownerDisplayName: null,
      takenOverAt: null,
      version: claimed.record.version + 1,
    });
  });

  it("tails no ownership for a conversation no teammate has ever been involved in", async () => {
    const { conversationRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });

    const tail = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, { includeOwnership: true });

    expect(tail).not.toHaveProperty("ownership");
  });

  it("presents a conversation whose owner's user is gone as waiting, without their label or claim time", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const claimedAt = new Date("2026-09-01T10:00:00.000Z");
    // What the foreign key leaves behind when the owner's user is deleted: only owner_user_id is nulled.
    conversationOwnershipRepository.items.set(conversation.id, {
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      state: "human_owned",
      ownerAccountId: "account-1",
      ownerUserId: null,
      ownerProfile: null,
      ownerStoredLabel: "gone@example.com",
      reason: "operator_takeover",
      version: 2,
      takenOverAt: claimedAt,
      createdAt: claimedAt,
      updatedAt: claimedAt,
    });

    const list = await service.listConversations("workspace-1", { limit: 50, offset: 0 });
    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 50 }, { includeOwnership: true });
    const tail = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, { includeOwnership: true });

    for (const ownership of [list.conversations.find((row) => row.id === conversation.id)?.ownership, detail.ownership, tail.ownership]) {
      expect(ownership).toMatchObject({ state: "human_owned", ownerUserId: null, ownerDisplayName: null, takenOverAt: null });
    }
    expect(JSON.stringify([list, detail, tail])).not.toContain("gone@example.com");
  });

  it("never includes ownership on public tail even when the conversation is human-owned", async () => {
    const { conversationRepository, messageRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const baseline = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "baseline",
    });
    const humanReply = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "public-visible human reply",
    });
    await conversationOwnershipRepository.takeOver({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      accountId: "operator-1",
      userId: "user-1",
      displayName: "Operator One",
    });

    const tail = await service.tailConversation("workspace-1", conversation.id, {
      cursor: messageRepository.cursorFor(baseline),
      limit: 10,
    });

    expect(tail).not.toHaveProperty("ownership");
    expect(tail.messages).toEqual([
      expect.objectContaining({
        id: humanReply.id,
        source: "human_agent",
        content: "public-visible human reply",
      }),
    ]);
    expect(tail.cursor).toBe(messageRepository.cursorFor(humanReply));
  });

  it("exposes the operator display name on a human-agent reply so the visitor can see who answered", async () => {
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const baseline = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "baseline",
    });
    const humanReply = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "I can help with that.",
      operatorAccountId: "operator-1",
      operatorUserId: "user-1",
      operatorDisplayName: "Joe",
    });

    const tail = await service.tailConversation("workspace-1", conversation.id, {
      cursor: messageRepository.cursorFor(baseline),
      limit: 10,
    });

    expect(tail.messages).toEqual([
      expect.objectContaining({
        id: humanReply.id,
        source: "human_agent",
        operatorDisplayName: "Joe",
      }),
    ]);
  });

  // A reply stored before replies recorded their author was signed with the organisation's name,
  // or with the replier's email where the organisation had none. Every surface shows the first and
  // none shows the second; a reply that names its author was signed under the never-an-email rule.
  const seedLegacyAndAttributedReplies = async () => {
    const setup = createService();
    const conversation = await setup.conversationRepository.create({ workspaceId: "workspace-1" });
    const baseline = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "baseline",
    });
    const legacyEmailReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Replied before replies named their author.",
      operatorAccountId: "operator-1",
      operatorDisplayName: "dana@example.com",
    });
    const legacyOrganisationReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Also replied before replies named their author.",
      operatorAccountId: "operator-1",
      operatorDisplayName: "Acme Support",
    });
    const attributedReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Replied with a signature.",
      operatorAccountId: "operator-1",
      operatorUserId: "user-1",
      operatorDisplayName: "Dana Scully",
    });
    const attributedEmailReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Replied with a signature that happens to be email-shaped.",
      operatorAccountId: "operator-1",
      operatorUserId: "user-2",
      operatorDisplayName: "carl@acme.example",
    });
    const embeddedEmailReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Replied with an address inside the signature.",
      operatorAccountId: "operator-1",
      operatorDisplayName: "Erin erin@acme\u3002example",
    });
    return {
      ...setup,
      conversation,
      baseline,
      legacyEmailReply,
      legacyOrganisationReply,
      attributedReply,
      attributedEmailReply,
      embeddedEmailReply,
    };
  };

  it("shows every stored signature but an email, on visitor and operator surfaces alike, attributed or not", async () => {
    const {
      service,
      messageRepository,
      conversation,
      baseline,
      legacyEmailReply,
      legacyOrganisationReply,
      attributedReply,
      attributedEmailReply,
      embeddedEmailReply,
    } = await seedLegacyAndAttributedReplies();
    const cursor = { cursor: messageRepository.cursorFor(baseline), limit: 10 };
    const page = { limit: 50, offset: 0 };

    const surfaces = [
      (await service.tailConversation("workspace-1", conversation.id, cursor)).messages,
      (await service.getConversation("workspace-1", conversation.id, page)).messages,
      (await service.tailConversation("workspace-1", conversation.id, cursor, { includeOwnership: true })).messages,
      (await service.getConversation("workspace-1", conversation.id, page, { includeOwnership: true })).messages,
    ];

    for (const messages of surfaces) {
      expect(messages.find((message) => message.id === legacyEmailReply.id)?.operatorDisplayName).toBeUndefined();
      expect(messages.find((message) => message.id === legacyOrganisationReply.id)?.operatorDisplayName).toBe("Acme Support");
      expect(messages.find((message) => message.id === attributedReply.id)?.operatorDisplayName).toBe("Dana Scully");
      expect(messages.find((message) => message.id === attributedEmailReply.id)?.operatorDisplayName).toBeUndefined();
      expect(messages.find((message) => message.id === embeddedEmailReply.id)?.operatorDisplayName).toBeUndefined();
    }
    expect(JSON.stringify(surfaces)).not.toContain("dana@example.com");
    expect(JSON.stringify(surfaces)).not.toContain("carl@acme.example");
    expect(JSON.stringify(surfaces)).not.toContain("erin@");
    await expect(service.getConversationTurn("workspace-1", legacyEmailReply.id))
      .resolves.toMatchObject({ message: { operatorDisplayName: undefined } });
    await expect(service.getConversationTurn("workspace-1", legacyOrganisationReply.id))
      .resolves.toMatchObject({ message: { operatorDisplayName: "Acme Support" } });
    await expect(service.getConversationTurn("workspace-1", attributedEmailReply.id))
      .resolves.toMatchObject({ message: { operatorDisplayName: undefined } });
  });
});

describe("chat history service reply attribution for operators", () => {
  // Replies from Dana (a display name set since she replied), Carl (no display name, so his
  // teammate label is his email, under an email-shaped organisation name that left his reply
  // unsigned), a teammate whose user is gone, and one stored before replies named their author.
  const seedReplies = async () => {
    const setup = createService();
    setup.teammateLabels.labels.set("user-dana", "Dana Scully");
    setup.teammateLabels.labels.set("user-carl", "carl@acme.example");
    const conversation = await setup.conversationRepository.create({ workspaceId: "workspace-1" });
    const baseline = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "baseline",
    });
    const reply = (content: string, operator: { userId?: string; displayName?: string }) =>
      setup.messageRepository.create({
        conversationId: conversation.id,
        workspaceId: "workspace-1",
        role: "assistant",
        source: "human_agent",
        content,
        operatorAccountId: "account-1",
        ...(operator.userId ? { operatorUserId: operator.userId } : {}),
        ...(operator.displayName ? { operatorDisplayName: operator.displayName } : {}),
      });
    const danaReply = await reply("From Dana.", { userId: "user-dana", displayName: "Dana" });
    const danaFollowUp = await reply("Dana again.", { userId: "user-dana", displayName: "Dana" });
    const carlReply = await reply("From Carl.", { userId: "user-carl" });
    const goneReply = await reply("From someone who left.", { userId: "user-gone", displayName: "Walter Skinner" });
    const legacyReply = await reply("Before replies named their author.", { displayName: "Acme Support" });
    const aiReply = await setup.messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "An AI answer.",
    });
    return { ...setup, conversation, baseline, danaReply, danaFollowUp, carlReply, goneReply, legacyReply, aiReply };
  };

  it("names the teammate who replied on operator reads, from their profile now, in one batched read", async () => {
    const seeded = await seedReplies();
    const { service, teammateLabels, messageRepository, conversation, baseline } = seeded;

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 50, offset: 0 }, {
      includeOperatorLabel: true,
    });
    const tail = await service.tailConversation("workspace-1", conversation.id, {
      cursor: messageRepository.cursorFor(baseline),
      limit: 10,
    }, { includeOperatorLabel: true });

    for (const messages of [detail.messages, tail.messages]) {
      const labelOf = (id: string) => messages.find((message) => message.id === id)?.operatorLabel;
      expect(labelOf(seeded.danaReply.id)).toBe("Dana Scully");
      expect(labelOf(seeded.danaFollowUp.id)).toBe("Dana Scully");
      expect(labelOf(seeded.carlReply.id)).toBe("carl@acme.example");
      // No profile to read: the reply's stored signature stands in.
      expect(labelOf(seeded.goneReply.id)).toBe("Walter Skinner");
      expect(labelOf(seeded.legacyReply.id)).toBe("Acme Support");
      expect(messages.find((message) => message.id === seeded.aiReply.id)).not.toHaveProperty("operatorLabel");
      // The visitor-facing signature is unchanged alongside it.
      expect(messages.find((message) => message.id === seeded.carlReply.id)?.operatorDisplayName).toBeUndefined();
      expect(messages.find((message) => message.id === seeded.danaReply.id)?.operatorDisplayName).toBe("Dana");
    }
    // One read per request, each teammate once.
    expect(teammateLabels.reads).toHaveLength(2);
    for (const read of teammateLabels.reads) {
      expect([...read].sort()).toEqual(["user-carl", "user-dana", "user-gone"]);
    }
  });

  it("names the replier on a single operator turn read", async () => {
    const { service, carlReply } = await seedReplies();

    await expect(service.getConversationTurn("workspace-1", carlReply.id, { includeOperatorLabel: true }))
      .resolves.toMatchObject({ message: { operatorLabel: "carl@acme.example" } });
  });

  it("keeps the replier's label off every read that does not ask for it, the visitor surface included", async () => {
    const { service, teammateLabels, messageRepository, conversation, baseline, carlReply } = await seedReplies();
    const cursor = { cursor: messageRepository.cursorFor(baseline), limit: 10 };
    const page = { limit: 50, offset: 0 };

    // The public/embed routes read with no options; the calling-agent update reader reads the
    // tail with ownership only. Neither may carry a teammate label, which can be an email.
    const reads = [
      (await service.tailConversation("workspace-1", conversation.id, cursor)).messages,
      (await service.getConversation("workspace-1", conversation.id, page, { includeAnswerFeedback: true })).messages,
      (await service.tailConversation("workspace-1", conversation.id, cursor, { includeOwnership: true })).messages,
      [(await service.getConversationTurn("workspace-1", carlReply.id)).message],
    ];

    for (const messages of reads) {
      for (const message of messages) {
        expect(message).not.toHaveProperty("operatorLabel");
      }
    }
    expect(JSON.stringify(reads)).not.toContain("carl@acme.example");
    expect(teammateLabels.reads).toEqual([]);
  });

  it("reads no profiles when no reply names its author", async () => {
    const { service, teammateLabels, conversationRepository, messageRepository } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "hello",
    });

    await service.getConversation("workspace-1", conversation.id, { limit: 50, offset: 0 }, { includeOperatorLabel: true });

    expect(teammateLabels.reads).toEqual([]);
  });
});

describe("chat history service conversation activity", () => {
  const createActivityService = () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const teammateLabels = new RecordingTeammateLabelReader();
    teammateLabels.labels.set("user-bea", "Bea");
    teammateLabels.labels.set("user-carl", "Carl");
    teammateLabels.labels.set("user-dana", "Dana");
    const activity = new InMemoryConversationActivityStore();
    const reads = createConversationActivityComposition({
      store: activity,
      teammateLabels,
      messages: messageRepository,
    }).reads;
    const service = new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      new InMemoryHistoryItemsRepository(conversationRepository, auditRepository),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      teammateLabels,
      reads,
    );
    return { service, conversationRepository, messageRepository, teammateLabels, activity };
  };

  const seedActivity = async () => {
    const setup = createActivityService();
    const conversation = await setup.conversationRepository.create({ workspaceId: "workspace-1" });
    const scope = { conversationId: conversation.id, workspaceId: "workspace-1" };
    await setup.activity.record(undefined, { ...scope, kind: "handed_back", actorUserId: "user-bea" });
    await setup.activity.record(undefined, {
      ...scope,
      kind: "feedback_resolved",
      actorUserId: "user-carl",
      detail: { assistantMessageId: "88888888-8888-4888-8888-888888888888", resolution: "knowledge_gap" },
    });
    return { ...setup, conversation, scope };
  };

  it("carries the activity on operator reads only, feedback outcomes only to a caller who may see them", async () => {
    const { service, conversation } = await seedActivity();
    const page = { limit: 50 };

    const withoutFeedback = await service.getConversation("workspace-1", conversation.id, page, {
      activity: { includeFeedback: false },
    });
    const withFeedback = await service.getConversation("workspace-1", conversation.id, page, {
      activity: { includeFeedback: true },
    });
    const tailWithoutFeedback = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, {
      activity: { includeFeedback: false },
    });
    const publicDetail = await service.getConversation("workspace-1", conversation.id, page);
    const publicTail = await service.tailConversation("workspace-1", conversation.id, { limit: 10 });

    expect(withoutFeedback.activity?.map((entry) => entry.kind)).toEqual(["handed_back"]);
    expect(tailWithoutFeedback.activity?.map((entry) => entry.kind)).toEqual(["handed_back"]);
    expect(withFeedback.activity).toEqual([
      expect.objectContaining({ kind: "handed_back", actor: { userId: "user-bea", label: "Bea" } }),
      expect.objectContaining({
        kind: "feedback_resolved",
        actor: { userId: "user-carl", label: "Carl" },
        resolution: "knowledge_gap",
      }),
    ]);
    for (const read of [publicDetail, publicTail]) {
      expect(read).not.toHaveProperty("activity");
      expect(read).not.toHaveProperty("activityCursor");
    }
  });

  it("labels the repliers and the activity's teammates in one lookup per read", async () => {
    const { service, messageRepository, teammateLabels, conversation } = await seedActivity();
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      source: "human_agent",
      content: "Dana here.",
      operatorAccountId: "account-1",
      operatorUserId: "user-dana",
    });
    const options = { includeOperatorLabel: true, activity: { includeFeedback: true } };

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 50 }, options);
    const tail = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, options);

    for (const read of [detail, tail]) {
      expect(read.messages.find((message) => message.content === "Dana here.")?.operatorLabel).toBe("Dana");
      expect(read.activity?.map((entry) => entry.actor?.label)).toEqual(["Bea", "Carl"]);
    }
    expect(teammateLabels.reads).toHaveLength(2);
    for (const read of teammateLabels.reads) {
      expect([...read].sort()).toEqual(["user-bea", "user-carl", "user-dana"]);
    }
  });

  it("tails only the activity recorded since the caller's cursor, and reads no labels when nothing is new", async () => {
    const { service, teammateLabels, activity, conversation, scope } = await seedActivity();
    const options = { activity: { includeFeedback: false } };

    const first = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, options);
    await activity.record(undefined, { ...scope, kind: "claimed", actorUserId: "user-dana" });
    const second = await service.tailConversation("workspace-1", conversation.id, {
      limit: 10,
      activityCursor: first.activityCursor ?? undefined,
    }, options);
    const readsBeforeIdlePoll = teammateLabels.reads.length;
    const idle = await service.tailConversation("workspace-1", conversation.id, {
      limit: 10,
      activityCursor: second.activityCursor ?? undefined,
    }, options);

    expect(first.activity?.map((entry) => entry.kind)).toEqual(["handed_back"]);
    expect(first.activityCursor).toBe(first.activity?.[0]?.id);
    expect(second.activity).toEqual([expect.objectContaining({ kind: "claimed", actor: { userId: "user-dana", label: "Dana" } })]);
    expect(second.activityCursor).toBe(second.activity?.[0]?.id);
    expect(idle.activity).toEqual([]);
    expect(idle.activityCursor).toBe(second.activityCursor);
    expect(teammateLabels.reads).toHaveLength(readsBeforeIdlePoll);
  });

  it("names no activity cursor for a conversation with no events", async () => {
    const { service, conversationRepository } = createActivityService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });

    const tail = await service.tailConversation("workspace-1", conversation.id, { limit: 10 }, {
      activity: { includeFeedback: true },
    });

    expect(tail).toMatchObject({ activity: [], activityCursor: null });
  });
});

describe("chat history service turn failure debug", () => {
  const detailInput = { limit: 50, offset: 0 };

  it("attaches turn-failure debug to the user message when includeTurnFailureDebug is set (dashboard)", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const userMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "first question",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        stream: false,
        supersededStage: "routing",
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeTurnFailureDebug: true,
    });

    const turn = detail.messages.find((message) => message.id === userMessage.id);
    expect(turn?.turnFailure).toEqual({
      eventStatus: "cancelled",
      recordedAt: expect.any(String),
      stream: false,
      stage: "routing",
      errorMessage: null,
    });
  });

  it("surfaces a genuine failure's error text the same way", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const userMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "second question",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "failure",
      metadata: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        stream: false,
        errorMessage: "Provider request timed out",
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeTurnFailureDebug: true,
    });

    const turn = detail.messages.find((message) => message.id === userMessage.id);
    expect(turn?.turnFailure).toMatchObject({
      eventStatus: "failure",
      errorMessage: "Provider request timed out",
    });
  });

  it("loads turn-failure debug only for user messages in the current window", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const olderUserMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "older question",
    });
    const visibleUserMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "visible question",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "visible answer",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: {
        conversationId: conversation.id,
        userMessageId: olderUserMessage.id,
        stream: false,
        supersededStage: "routing",
      },
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: {
        conversationId: conversation.id,
        userMessageId: visibleUserMessage.id,
        stream: false,
        supersededStage: "rendering",
      },
    });

    const requestedUserMessageIds: string[][] = [];
    const originalBoundedLookup = auditRepository.listUnansweredChatAnswerEventsByUserMessageIds.bind(auditRepository);
    auditRepository.listUnansweredChatAnswerEventsByUserMessageIds = async (
      workspaceId,
      conversationId,
      userMessageIds,
    ) => {
      requestedUserMessageIds.push(userMessageIds);
      return originalBoundedLookup(workspaceId, conversationId, userMessageIds);
    };
    auditRepository.listChatAnswerEventsByConversationId = async () => {
      throw new Error("conversation-wide chat.answer scan should not run for paginated detail");
    };

    const detail = await service.getConversation("workspace-1", conversation.id, { limit: 2, offset: 0 }, {
      includeTurnFailureDebug: true,
    });

    expect(requestedUserMessageIds).toEqual([[visibleUserMessage.id]]);
    expect(detail.messages.map((message) => message.id)).toEqual([
      visibleUserMessage.id,
      expect.any(String),
    ]);
    expect(detail.messages.find((message) => message.id === visibleUserMessage.id)?.turnFailure).toMatchObject({
      eventStatus: "cancelled",
      stage: "rendering",
    });
    expect(detail.messages.some((message) => message.id === olderUserMessage.id)).toBe(false);
  });

  it("omits turn-failure debug when includeTurnFailureDebug is unset (public surface)", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const userMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "first question",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "cancelled",
      metadata: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        stream: false,
        supersededStage: "routing",
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput);

    const turn = detail.messages.find((message) => message.id === userMessage.id);
    expect(turn?.turnFailure).toBeUndefined();
  });

  it("does not attach turn-failure debug once the turn produced an assistant message", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const userMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "third question",
    });
    const assistantMessage = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "answer",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        stream: false,
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id, detailInput, {
      includeTurnFailureDebug: true,
    });

    const turn = detail.messages.find((message) => message.id === userMessage.id);
    expect(turn?.turnFailure).toBeUndefined();
  });
});

describe("chat history service", () => {
  it("projects persisted coverage and recorded reactions onto its correlated assistant turn in two bounded reads", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
    const coverageReader = new InMemoryAnswerCoverageHistoryReader();
    const service = new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      historyItemsRepository,
      undefined,
      undefined,
      undefined,
      coverageReader,
    );
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const user = await messageRepository.create({
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      role: "user",
      content: "What remains unresolved?",
    });
    const assistant = await messageRepository.create({
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      role: "assistant",
      content: "Part of the answer is available.",
    });
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
      },
    });
    coverageReader.assessments.set(user.id, {
      id: "assessment-1",
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      requestMessageId: user.id,
      originatingTurnId: user.id,
      contextualizedRequest: "user: What remains unresolved?",
      assistantMessageId: assistant.id,
      availability: "assessed",
      coverage: "partial",
      reason: "insufficient_evidence",
      unresolvedRequest: "The policy exception.",
      schemaVersion: 1,
      producer: "answer_head",
      interactionEvaluationState: "evaluated",
      assessedAt: new Date("2026-09-08T10:00:00.000Z"),
      createdAt: new Date("2026-09-08T10:00:00.000Z"),
    });
    coverageReader.reactions.set("assessment-1", [{
      id: "reaction-1",
      assessmentId: "assessment-1",
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      reactionKey: "routine-execution-1",
      routineId: "routine-1",
      routineExecutionId: "routine-execution-1",
      targetMessageId: assistant.id,
      evaluationState: "evaluated",
      evaluationIndex: 1,
      decision: "matched",
      reasonCode: "coverage_criteria_matched",
      createdAt: new Date("2026-09-08T10:00:01.000Z"),
    }]);

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.id === assistant.id)?.debug;

    expect(debug?.answerCoverage).toEqual({
      availability: "assessed",
      coverage: "partial",
      reason: "insufficient_evidence",
      contextualizedRequest: "user: What remains unresolved?",
      unresolvedRequest: "The policy exception.",
      originatingTurnId: user.id,
      originatingRequestId: user.id,
      schemaVersion: 1,
      assessedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(debug?.interactionTrace).toEqual({
      state: "evaluated",
      consumedAssessment: { coverage: "partial", reason: "insufficient_evidence" },
      decisions: [{
        assessmentRequestId: user.id,
        target: "routine",
        targetId: "routine-1",
        decision: "matched",
        reasonCode: "coverage_criteria_matched",
        routineExecutionId: "routine-execution-1",
        targetMessageId: assistant.id,
      }],
    });
    expect(coverageReader.assessmentReads).toBe(1);
    expect(coverageReader.reactionReads).toBe(1);
  });

  it("keeps evaluated no-match separate from unavailable assessment", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
    const coverageReader = new InMemoryAnswerCoverageHistoryReader();
    const service = new ChatHistoryService(
      conversationRepository, messageRepository, auditRepository, historyItemsRepository,
      undefined, undefined, undefined, coverageReader,
    );
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    const user = await messageRepository.create({ workspaceId: "workspace-1", conversationId: conversation.id, role: "user", content: "Question" });
    const assistant = await messageRepository.create({ workspaceId: "workspace-1", conversationId: conversation.id, role: "assistant", content: "Answer" });
    await auditRepository.create({ workspaceId: "workspace-1", eventType: "chat.answer", eventStatus: "success", metadata: { conversationId: conversation.id, userMessageId: user.id, assistantMessageId: assistant.id } });
    coverageReader.assessments.set(user.id, {
      id: "assessment-2", workspaceId: "workspace-1", conversationId: conversation.id,
      requestMessageId: user.id, originatingTurnId: user.id, contextualizedRequest: "Question",
      assistantMessageId: assistant.id,
      availability: "assessed", coverage: "answered", reason: "sufficient_evidence", schemaVersion: 1, producer: "answer_head",
      interactionEvaluationState: "evaluated",
      assessedAt: new Date("2026-09-08T10:00:00.000Z"), createdAt: new Date("2026-09-08T10:00:00.000Z"),
    });

    const debug = (await service.getConversation("workspace-1", conversation.id)).messages.find((message) => message.id === assistant.id)?.debug;
    expect(debug?.interactionTrace).toEqual({
      state: "evaluated",
      consumedAssessment: { coverage: "answered", reason: "sufficient_evidence" },
      decisions: [],
    });
  });

  it("replays activity trace metadata for assistant turns", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What does this page do?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "It answers questions.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
        metadata: {
          conversationId: conversation.id,
          assistantMessageId: assistant.id,
          citationCount: 1,
          route: {
            generator: "assistant",
            routeType: "retrieval",
            routeReason: "evidence_required",
            retrievalInvoked: true,
          },
          retrieval: {
            rewriteStatus: "skipped",
            rerankStatus: "applied",
          originalCandidateCount: 1,
          rewrittenCandidateCount: 0,
          lexicalCandidateCount: 1,
          normalizedCandidateCount: 1,
          finalContextCount: 1,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          triggerAnalysis: {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-only",
                matched: true,
                matchStrength: 0.88,
                reason: "The question asks about an upcoming event.",
                triggerInstructionPreview: "Enact for upcoming events.",
              },
            ],
            matchedRuleIds: ["events-only"],
            unmatchedRuleIds: [],
            matchCount: 1,
            matcherVersion: "test",
          },
          triggerBackoff: {
            applied: true,
            reason: "empty_filtered_candidates",
            relaxedRuleIds: ["events-only"],
            restoredCandidateCount: 1,
          },
        },
        activityTrace: {
          traceId: "trace-1",
          startedAt: "2026-03-23T00:00:00.000Z",
          stages: [
            {
              stageId: "trigger_analysis",
              kind: "trigger_analysis",
              label: "Trigger analysis",
              status: "applied",
            },
            {
              stageId: "answer",
              kind: "answer_outcome",
              label: "Answer outcome",
              status: "applied",
            },
          ],
          links: [],
        },
        answerOutcome: "grounded_success",
        suggestions: [
          {
            text: "What examples does it include?",
            citation: {
              documentId: "doc-2",
              chunkId: "chunk-2",
              title: "Examples",
            },
          },
        ],
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");
    const debug = assistantMessage?.debug;

    expect(debug?.activitySummary?.candidateCounts).toMatchObject({
      semantic: 1,
      lexical: 1,
      merged: 1,
      final: 1,
    });
    expect(debug?.activitySummary?.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(debug?.activitySummary?.triggerBackoff).toMatchObject({
      applied: true,
      relaxedRuleIds: ["events-only"],
    });
    expect(debug?.activitySummary?.execution).toEqual({
      surface: "assistant",
      path: "assistant_retrieval",
      retrievalInvoked: true,
    });
    expect(debug?.activityTrace).toMatchObject({
      traceId: "trace-1",
      stages: [
        expect.objectContaining({ stageId: "trigger_analysis" }),
        expect.objectContaining({ stageId: "answer" }),
      ],
    });
    expect(debug?.answerOutcome).toBe("grounded_success");
    expect(debug).toMatchObject({
      skillName: "retrieval.answer",
      skillOutcome: "grounded",
      skillStatus: "completed",
    });
    expect(debug?.route).toEqual({
      generator: "assistant",
      routeType: "retrieval",
      routeReason: "evidence_required",
      retrievalInvoked: true,
    });
    expect(assistantMessage?.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Examples",
        },
      }),
    ]);
    expect(debug).not.toHaveProperty("validation");

    // Legacy turn (no persisted envelope): synthesize a version-0 envelope wrapping
    // the activity trace as a retrieval leaf so the renderer receives an envelope.
    expect(debug?.turnTrace?.version).toBe(0);
    const legacyStage = debug?.turnTrace?.spine.stages[0];
    expect(legacyStage?.kind).toBe("skill_dispatch");
    expect(legacyStage?.id).toBe("dispatch:retrieval.answer");
    expect(legacyStage?.subTrace?.namespace).toBe("retrieval");
    expect((legacyStage?.subTrace?.payload as { traceId?: string })?.traceId).toBe("trace-1");
  });

  it("prefers a persisted turn-trace envelope over synthesizing one", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Question?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Answer.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        turnTrace: {
          version: 1,
          spine: {
            traceId: "conversation-turn-9",
            startedAt: "2026-03-23T00:00:00.000Z",
            stages: [
              { id: "gather", kind: "gather", status: "applied" },
              {
                id: "dispatch:retrieval.answer",
                kind: "skill_dispatch",
                status: "applied",
                subTrace: { namespace: "retrieval", version: 1, payload: { traceId: "persisted-trace" } },
              },
            ],
          },
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.role === "assistant")?.debug;

    expect(debug?.turnTrace?.version).toBe(1);
    expect(debug?.turnTrace?.spine.traceId).toBe("conversation-turn-9");
    expect(debug?.turnTrace?.spine.stages.map((stage) => stage.kind)).toEqual(["gather", "skill_dispatch"]);
  });

  it("reconstructs an activity trace for historical assistant turns that only stored retrieval diagnostics", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "sqrt(5) and tell me about kriya",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "I can tell you about Kriya Yoga.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 2,
        citations: [
          { documentId: "doc-1", chunkId: "chunk-1", title: "Kriya overview" },
          { documentId: "doc-1", chunkId: "chunk-2", title: "Kriya history" },
        ],
        route: {
          generator: "assistant",
          routeType: "retrieval",
          routeReason: "evidence_required",
          retrievalInvoked: true,
        },
        retrieval: {
          rewriteStatus: "applied",
          rerankStatus: "skipped",
          originalCandidateCount: 13,
          rewrittenCandidateCount: 50,
          lexicalCandidateCount: 0,
          normalizedCandidateCount: 50,
          finalContextCount: 5,
          candidateFallbackApplied: false,
          fallbackApplied: false,
          retrievalSkipped: false,
          triggerAnalysis: {
            status: "applied",
            consideredRules: [
              {
                ruleId: "events-only",
                matched: false,
                matchStrength: 0.09,
                reason: "Query asks about sqrt(5) and kriya, not a time-bound course, celebration, or event.",
                triggerInstructionPreview: "enact when the user is asking about courses, celebrations or events that are time-bound",
              },
            ],
            matchedRuleIds: [],
            unmatchedRuleIds: ["events-only"],
            matchCount: 0,
            matcherVersion: "test",
          },
          shapeSelection: {
            shapeName: "default_hybrid",
            queryShape: "general_grounding",
            selectionMode: "deterministic",
            callerSurface: "assistant",
            resolvedRun: {
              skillName: "retrieval.answer",
              resolvedSteps: [],
            },
          },
        },
        answerOutcome: "grounded_success",
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.role === "assistant")?.debug;

    expect(debug?.activitySummary?.candidateCounts).toEqual({
      semantic: 63,
      lexical: 0,
      temporal: 0,
      merged: 50,
      final: 5,
    });
    expect(debug?.activityTrace).toMatchObject({
      traceId: expect.stringMatching(/^reconstructed-/),
      stages: [
        expect.objectContaining({ stageId: "routing", kind: "routing" }),
        expect.objectContaining({ stageId: "interpretation", kind: "query_interpretation" }),
        expect.objectContaining({ stageId: "trigger_analysis", kind: "trigger_analysis" }),
        expect.objectContaining({ stageId: "shape_selection", kind: "shape_selection" }),
        expect.objectContaining({ stageId: "candidate_summary", kind: "diagnostics" }),
        expect.objectContaining({ stageId: "answer", kind: "answer_outcome" }),
      ],
    });
    expect(debug?.activityTrace?.links).toHaveLength(5);

    const diagnosticsStage = debug?.activityTrace?.stages.find(
      (stage) => stage.stageId === "candidate_summary",
    );
    expect(diagnosticsStage?.outputs).toMatchObject({
      finalContexts: [
        { documentId: "doc-1", chunkId: "chunk-1", title: "Kriya overview" },
        { documentId: "doc-1", chunkId: "chunk-2", title: "Kriya history" },
      ],
    });
  });

  it("surfaces citations and the debug envelope for suspended (action-required) turns", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Please email the course details to the team.",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Here is a draft you can copy/paste.",
    });

    // HITL / durable-async turns persist their audit event as `chat.suspended`,
    // not `chat.answer`. The history panel must still resolve their citations and
    // turn-trace envelope from that record.
    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.suspended",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 1,
        citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Course overview" }],
        answerOutcome: "grounded_success",
        turnTrace: {
          version: 1,
          spine: {
            traceId: "conversation-turn-suspended",
            startedAt: "2026-03-23T00:00:00.000Z",
            stages: [{ id: "gather", kind: "gather", status: "applied" }],
          },
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");

    expect(assistantMessage?.citations).toEqual([
      { documentId: "doc-1", chunkId: "chunk-1", title: "Course overview" },
    ]);
    expect(assistantMessage?.debug?.turnTrace?.spine.traceId).toBe("conversation-turn-suspended");
  });

  it("preserves provider-defined suggestion kinds and action payloads on reload", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Can you help with billing?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "I don't have information about that.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        suggestions: [
          {
            text: "Contact us",
            kind: "contact_human",
            action: {
              kind: "start_intent",
              intent: { skillName: "human_contact.request", intentName: "no_context_refusal" },
            },
          },
          {
            text: "What's covered here?",
            kind: "deeper",
          },
        ],
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");

    expect(assistantMessage?.suggestions).toEqual([
      {
        text: "Contact us",
        kind: "contact_human",
        action: {
          kind: "start_intent",
          intent: { skillName: "human_contact.request", intentName: "no_context_refusal" },
        },
      },
      {
        text: "What's covered here?",
        kind: "deeper",
      },
    ]);
  });

  it("drops malformed action payloads while keeping the rest of the suggestion", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Anything?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Hmm.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        suggestions: [
          {
            text: "Broken action chip",
            kind: "contact_human",
            action: { kind: "start_intent" },
          },
        ],
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");

    expect(assistantMessage?.suggestions).toEqual([
      {
        text: "Broken action chip",
        kind: "contact_human",
      },
    ]);
  });

  it("replays backfilled message skill outcome for historical skill intake metadata", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Contact me",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "We will contact you.",
      skillName: "human_contact.request",
      skillOutcome: "sent",
      skillStatus: "completed",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        answerOutcome: "non_retrieval_response",
        citationCount: 0,
        skillIntake: {
          skillName: "human_contact.request",
          status: "completed",
          stateId: "state-1",
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.role === "assistant")?.debug;

    expect(debug).toMatchObject({
      answerOutcome: "non_retrieval_response",
      skillName: "human_contact.request",
      skillOutcome: "sent",
      skillStatus: "completed",
    });
  });

  it("ignores skill outcome metadata with invalid statuses", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What happened?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Something happened.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        skillTurn: {
          skillName: "custom.skill",
          outcome: "done",
          status: "not-a-status",
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.role === "assistant")?.debug;

    expect(debug).not.toHaveProperty("skillName");
    expect(debug).not.toHaveProperty("skillOutcome");
    expect(debug).not.toHaveProperty("skillStatus");
  });

  it("uses unknown instead of status when legacy skill intake has no outcome", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Run the custom skill",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Done.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        skillIntake: {
          skillName: "custom.skill",
          status: "completed",
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const debug = detail.messages.find((message) => message.role === "assistant")?.debug;

    expect(debug).toMatchObject({
      skillName: "custom.skill",
      skillOutcome: "unknown",
      skillStatus: "completed",
    });
  });

  it("normalizes legacy stored suggestions without kind as deeper suggestions", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What does this page do?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "It answers questions.",
    });

    await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "chat.answer",
      eventStatus: "success",
      metadata: {
        conversationId: conversation.id,
        assistantMessageId: assistant.id,
        citationCount: 0,
        suggestions: [
          {
            text: "What examples does it include?",
            citation: {
              documentId: "doc-2",
              chunkId: "chunk-2",
              title: "Examples",
            },
          },
        ],
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");

    expect(assistantMessage?.suggestions).toEqual([
      expect.objectContaining({
        text: expect.any(String),
        kind: "deeper",
        citation: {
          documentId: "doc-2",
          chunkId: "chunk-2",
          title: "Examples",
        },
      }),
    ]);
  });

  it("lists mixed history items entries ordered by newest activity", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();
    const olderConversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    olderConversation.updatedAt = new Date("2026-04-20T10:00:00.000Z");
    olderConversation.createdAt = new Date("2026-04-20T09:00:00.000Z");
    await messageRepository.create({
      conversationId: olderConversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What is older?",
    });
    await messageRepository.create({
      conversationId: olderConversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Older answer",
    });

    const searchEvent = await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "document.search",
      eventStatus: "success",
      metadata: {
        searchId: "11111111-1111-4111-8111-111111111111",
        query: "course calendar",
        resultCount: 2,
        results: [
          {
            documentId: "22222222-2222-4222-8222-222222222222",
            title: "Course Calendar",
            status: "ready",
            ragStatus: "processed",
            metadata: {},
            score: 0.92,
            rank: 1,
            matchEvidence: ["calendar"],
            sourceKind: "inline_text",
          },
          {
            documentId: "33333333-3333-4333-8333-333333333333",
            title: "Workshop Notes",
            status: "ready",
            ragStatus: "processed",
            metadata: {},
            score: 0.75,
            rank: 2,
            matchEvidence: ["workshop"],
            sourceKind: "inline_text",
          },
        ],
        activityTrace: {
          traceId: "trace-1",
          startedAt: "2026-04-21T10:00:00.000Z",
          stages: [],
          links: [],
        },
      },
    });
    searchEvent.createdAt = new Date("2026-04-21T10:00:00.000Z");

    const newestConversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    newestConversation.updatedAt = new Date("2026-04-22T10:00:00.000Z");
    await messageRepository.create({
      conversationId: newestConversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Newest question",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.total).toBe(2);
    expect(itemsPage.hasMore).toBe(false);
    expect(itemsPage.nextCursor).toBeNull();
    expect(itemsPage.items.map((item) => item.kind)).toEqual(["chat", "chat"]);
    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: newestConversation.id,
      conversation: {
        messageCount: 1,
        preview: "Newest question",
      },
    });
    expect(itemsPage.items).not.toContainEqual(expect.objectContaining({
      kind: "search",
      id: "11111111-1111-4111-8111-111111111111",
    }));
  });

  it("skips the contact-history fetch once a chat-only filter (q/agent/site/outcome) is active, and forwards filters to the repository", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
    let contactCalls = 0;
    const contactProvider: ContactHistoryProviderPort = {
      async listPageByWorkspaceId() {
        contactCalls += 1;
        return { contacts: [], total: 0, nextCursor: null, hasMore: false };
      },
      async getById() {
        return null;
      },
    };
    const service = new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      historyItemsRepository,
      contactProvider,
    );
    const matchingConversation = await conversationRepository.create({ workspaceId: "workspace-1", agentId: "agent-1" });
    await conversationRepository.create({ workspaceId: "workspace-1", agentId: "agent-2" });

    // No filter: contacts are fetched as usual.
    await service.listItems("workspace-1", { limit: 50, offset: 0 });
    expect(contactCalls).toBe(1);

    // agentId active: the contact fetch is skipped entirely (fetch-then-discard would
    // still cost a request), and the repository call narrows to that agent's conversation.
    const filtered = await service.listItems("workspace-1", { limit: 50, offset: 0, agentId: "agent-1" });
    expect(contactCalls).toBe(1);
    expect(filtered.items.flatMap((item) => (item.kind === "chat" ? [item.conversation.id] : [])))
      .toEqual([matchingConversation.id]);
  });

  it("previews the visitor's first user message, not the newest agent reply", async () => {
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    conversation.updatedAt = new Date("2026-04-24T10:00:00.000Z");
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What are your shop hours?",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "We're open 9-5",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: conversation.id,
      conversation: {
        preview: "What are your shop hours?",
      },
    });
  });

  it("falls back to the newest message preview when a conversation has no user message yet", async () => {
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    conversation.updatedAt = new Date("2026-04-24T11:00:00.000Z");
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Still here if you need anything",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: conversation.id,
      conversation: {
        preview: "Still here if you need anything",
      },
    });
  });

  it("skips a whitespace-only first user message and previews the next meaningful one", async () => {
    const { conversationRepository, messageRepository, service } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    conversation.updatedAt = new Date("2026-04-25T10:00:00.000Z");
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "   ",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "Hi, how can I help?",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "What are your shop hours?",
    });
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "We're open 9-5",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: conversation.id,
      conversation: {
        preview: "What are your shop hours?",
      },
    });
  });

  it("keeps document searches out of paginated conversation history", async () => {
    const { conversationRepository, auditRepository, service } = createService();
    const first = await conversationRepository.create({ workspaceId: "workspace-1" });
    first.updatedAt = new Date("2026-04-23T10:00:00.000Z");
    const second = await auditRepository.create({
      workspaceId: "workspace-1",
      eventType: "document.search",
      eventStatus: "success",
      metadata: {
        searchId: "44444444-4444-4444-8444-444444444444",
        query: "second",
        resultCount: 0,
        results: [],
      },
    });
    second.createdAt = new Date("2026-04-22T10:00:00.000Z");
    const third = await conversationRepository.create({ workspaceId: "workspace-1" });
    third.updatedAt = new Date("2026-04-21T10:00:00.000Z");

    const itemsPage = await service.listItems("workspace-1", { limit: 1, offset: 1 });

    expect(itemsPage.total).toBe(2);
    expect(itemsPage.hasMore).toBe(false);
    expect(itemsPage.items).toHaveLength(1);
    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: third.id,
    });
  });

  it("includes human contact requests in mixed activity and returns linked conversation detail", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
    const contactHistoryProvider = new InMemoryContactHistoryProvider();
    const service = new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      historyItemsRepository,
      contactHistoryProvider,
    );

    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });
    conversation.updatedAt = new Date("2026-04-21T10:00:00.000Z");
    const user = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Can I speak with a person?",
    });
    user.createdAt = new Date("2026-04-21T10:01:00.000Z");
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "I can collect that request.",
    });
    assistant.createdAt = new Date("2026-04-21T10:02:00.000Z");

    contactHistoryProvider.contacts.push({
      id: "55555555-5555-4555-8555-555555555555",
      sortAt: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      conversationId: conversation.id,
      assistantMessageId: assistant.id,
      sourceChannel: "website_embed",
      sourceOrigin: "https://example.com/help",
      userEmail: "customer@example.com",
      messagePreview: "Please contact me about billing.",
      message: "Please contact me about billing.",
      triggerSource: "manual",
      triggerReason: null,
      status: "pending",
      attempts: 0,
      finalDeliveryError: null,
      createdAt: "2026-04-22T10:00:00.000Z",
      updatedAt: "2026-04-22T10:00:00.000Z",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.total).toBe(2);
    expect(itemsPage.items[0]).toMatchObject({
      kind: "contact",
      id: "55555555-5555-4555-8555-555555555555",
      contact: {
        userEmail: "customer@example.com",
        messagePreview: "Please contact me about billing.",
      },
    });

    const detail = await service.getContactRequest("workspace-1", "55555555-5555-4555-8555-555555555555");

    expect(detail.contact).toMatchObject({
      userEmail: "customer@example.com",
      message: "Please contact me about billing.",
    });
    expect(detail.conversation.messages.map((message) => message.content)).toEqual([
      "Can I speak with a person?",
      "I can collect that request.",
    ]);
  });
});

describe("chat history service visitor profile (spec 1277, FR-040/041)", () => {
  it("attaches the visitor profile, request context, and entry referrer only when includeAgentInternalName is set", async () => {
    const { service, conversationRepository, visitorRepository } = createService();
    const visitor = buildVisitor();
    visitorRepository.visitors.set(visitor.id, visitor);
    const conversation = await conversationRepository.create({
      workspaceId: "workspace-1",
      visitorId: visitor.id,
      entryReferrer: "https://example.com/",
      requestContext: {
        clientIp: "203.0.113.4",
        country: "US",
        region: "CA",
        city: "San Francisco",
        userAgent: "Mozilla/5.0",
        acceptLanguage: "en-US,en;q=0.9",
        observedVia: "edge_proof",
      },
    });

    const dashboardDetail = await service.getConversation(
      "workspace-1",
      conversation.id,
      { limit: 10 },
      { includeAgentInternalName: true },
    );
    expect(dashboardDetail.entryReferrer).toBe("https://example.com/");
    expect(dashboardDetail.requestContext).toMatchObject({ clientIp: "203.0.113.4", country: "US" });
    expect(dashboardDetail.visitor).toMatchObject({
      id: visitor.id,
      firstSeenAt: visitor.firstSeenAt.toISOString(),
      conversationCount: visitor.conversationCount,
      verified: false,
    });

    const publicDetail = await service.getConversation("workspace-1", conversation.id, { limit: 10 });
    expect(publicDetail).not.toHaveProperty("entryReferrer");
    expect(publicDetail).not.toHaveProperty("requestContext");
    expect(publicDetail).not.toHaveProperty("visitor");
  });

  it("derives verified from a non-null verified_customer_id on the visitor row", async () => {
    const { service, conversationRepository, visitorRepository } = createService();
    const visitor = buildVisitor({ verifiedCustomerId: "customer-42" });
    visitorRepository.visitors.set(visitor.id, visitor);
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1", visitorId: visitor.id });

    const detail = await service.getConversation(
      "workspace-1",
      conversation.id,
      { limit: 10 },
      { includeAgentInternalName: true },
    );

    expect(detail.visitor).toMatchObject({ verified: true });
  });

  it("reports a null visitor, request context, and entry referrer for a conversation with none of the three", async () => {
    const { service, conversationRepository } = createService();
    const conversation = await conversationRepository.create({ workspaceId: "workspace-1" });

    const detail = await service.getConversation(
      "workspace-1",
      conversation.id,
      { limit: 10 },
      { includeAgentInternalName: true },
    );

    expect(detail.visitor).toBeNull();
    expect(detail.requestContext).toBeNull();
    expect(detail.entryReferrer).toBeNull();
  });

  it("maps visitorCountry on a conversation summary from its own request context, with no visitors join", async () => {
    const { service, conversationRepository } = createService();
    await conversationRepository.create({
      workspaceId: "workspace-1",
      requestContext: {
        clientIp: "203.0.113.4",
        country: "DE",
        region: null,
        city: null,
        userAgent: null,
        acceptLanguage: null,
        observedVia: "backend",
      },
    });
    await conversationRepository.create({ workspaceId: "workspace-1" });

    const page = await service.listConversations("workspace-1", { limit: 10 });

    const withCountry = page.conversations.find((conversation) => conversation.visitorCountry === "DE");
    const withoutCountry = page.conversations.find((conversation) => conversation.visitorCountry === null);
    expect(withCountry).toBeDefined();
    expect(withoutCountry).toBeDefined();
  });

  it("lists a visitor's other conversations, excluding one by id, in the same paged summary shape", async () => {
    const { service, conversationRepository, visitorRepository } = createService();
    const visitor = buildVisitor();
    visitorRepository.visitors.set(visitor.id, visitor);
    const first = await conversationRepository.create({ workspaceId: "workspace-1", visitorId: visitor.id });
    const second = await conversationRepository.create({ workspaceId: "workspace-1", visitorId: visitor.id });
    const third = await conversationRepository.create({ workspaceId: "workspace-1", visitorId: visitor.id });

    const page = await service.listVisitorConversations("workspace-1", visitor.id, {
      limit: 10,
      exclude: second.id,
    });

    const ids = page.conversations.map((conversation) => conversation.id);
    expect(ids).toEqual(expect.arrayContaining([first.id, third.id]));
    expect(ids).not.toContain(second.id);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it("paginates a visitor's conversations with limit and offset", async () => {
    const { service, conversationRepository, visitorRepository } = createService();
    const visitor = buildVisitor();
    visitorRepository.visitors.set(visitor.id, visitor);
    for (let index = 0; index < 3; index += 1) {
      await conversationRepository.create({ workspaceId: "workspace-1", visitorId: visitor.id });
    }

    const firstPage = await service.listVisitorConversations("workspace-1", visitor.id, { limit: 2, offset: 0 });
    expect(firstPage.conversations).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await service.listVisitorConversations("workspace-1", visitor.id, { limit: 2, offset: 2 });
    expect(secondPage.conversations).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it("404s for a visitor id that does not resolve in the given workspace", async () => {
    const { service, visitorRepository } = createService();
    const visitor = buildVisitor({ workspaceId: "workspace-2" });
    visitorRepository.visitors.set(visitor.id, visitor);

    await expect(
      service.listVisitorConversations("workspace-1", visitor.id, { limit: 10 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
