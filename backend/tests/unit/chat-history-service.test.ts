import { describe, expect, it } from "vitest";

import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type {
  ContactHistoryDetail,
  ContactHistoryProviderPort,
  ContactHistorySummary,
} from "../../src/modules/chat/services/contactHistoryProvider.js";
import {
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryHistoryItemsRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const createService = () => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const auditRepository = new InMemoryAuditEventRepository();
  const historyItemsRepository = new InMemoryHistoryItemsRepository(conversationRepository, auditRepository);
  return {
    conversationRepository,
    messageRepository,
    auditRepository,
    service: new ChatHistoryService(conversationRepository, messageRepository, auditRepository, historyItemsRepository),
  };
};

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

describe("chat history service", () => {
  it("replays retrieval trace metadata for assistant turns", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create("workspace-1");
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
        retrievalTrace: {
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
        answerOutcome: "grounded_degraded_unsupported_segments",
        conversationMode: "exploratory",
        conversationModeMetadata: {
          conversationMode: "exploratory",
          brevityOverrideApplied: false,
          expansionApplied: true,
          expansionKind: "expansive",
          suggestionCount: 2,
          followUpQuestionApplied: true,
        },
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
        validation: {
          ran: true,
          answerModified: true,
          unsupportedSegmentCount: 1,
          substantiveUnsupportedSegmentCount: 1,
          supportedSegmentCount: 1,
          nonSubstantiveSegmentCount: 1,
          hiddenSupportUsed: true,
          hiddenSupportKindsUsed: ["assistant_name"],
          segmentResults: [
            {
              originalText: "It answers questions.",
              text: "It answers questions.",
              disposition: "supported",
              replacementApplied: false,
              reason: "has_support_reference",
            },
            {
              originalText: "I couldn't verify that part from the retrieved documents.",
              text: "I couldn't verify that part from the retrieved documents.",
              disposition: "unsupported",
              replacementApplied: true,
              reason: "missing_support_reference",
            },
          ],
        },
      },
    });

    const detail = await service.getConversation("workspace-1", conversation.id);
    const assistantMessage = detail.messages.find((message) => message.role === "assistant");
    const debug = assistantMessage?.debug;

    expect(debug?.retrievalInfo?.candidateCounts).toMatchObject({
      semantic: 1,
      lexical: 1,
      merged: 1,
      final: 1,
    });
    expect(debug?.retrievalInfo?.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(debug?.retrievalInfo?.triggerBackoff).toMatchObject({
      applied: true,
      relaxedRuleIds: ["events-only"],
    });
    expect(debug?.retrievalInfo?.execution).toEqual({
      surface: "assistant",
      path: "assistant_retrieval",
      retrievalInvoked: true,
    });
    expect(debug?.retrievalTrace).toMatchObject({
      traceId: "trace-1",
      stages: [
        expect.objectContaining({ stageId: "trigger_analysis" }),
        expect.objectContaining({ stageId: "answer" }),
      ],
    });
    expect(debug?.answerOutcome).toBe("grounded_degraded_unsupported_segments");
    expect(debug?.route).toEqual({
      generator: "assistant",
      routeType: "retrieval",
      routeReason: "evidence_required",
      retrievalInvoked: true,
    });
    expect(debug?.conversationMode).toBe("exploratory");
    expect(debug?.conversationModeMetadata).toEqual({
      conversationMode: "exploratory",
      brevityOverrideApplied: false,
      expansionApplied: true,
      expansionKind: "expansive",
      suggestionCount: 2,
      followUpQuestionApplied: true,
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
    expect(debug?.validation).toEqual({
      ran: true,
      answerModified: true,
      unsupportedSegmentCount: 1,
      substantiveUnsupportedSegmentCount: 1,
      supportedSegmentCount: 1,
      nonSubstantiveSegmentCount: 1,
      hiddenSupportUsed: true,
      hiddenSupportKindsUsed: ["assistant_name"],
      segmentResults: [
        {
          originalText: "It answers questions.",
          text: "It answers questions.",
          disposition: "supported",
          replacementApplied: false,
          reason: "has_support_reference",
        },
        {
          originalText: "I couldn't verify that part from the retrieved documents.",
          text: "I couldn't verify that part from the retrieved documents.",
          disposition: "unsupported",
          replacementApplied: true,
          reason: "missing_support_reference",
        },
      ],
    });
  });

  it("normalizes legacy stored suggestions without kind as deeper suggestions", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create("workspace-1");
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
    const olderConversation = await conversationRepository.create("workspace-1");
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
        retrievalTrace: {
          traceId: "trace-1",
          startedAt: "2026-04-21T10:00:00.000Z",
          stages: [],
          links: [],
        },
      },
    });
    searchEvent.createdAt = new Date("2026-04-21T10:00:00.000Z");

    const newestConversation = await conversationRepository.create("workspace-1");
    newestConversation.updatedAt = new Date("2026-04-22T10:00:00.000Z");
    await messageRepository.create({
      conversationId: newestConversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Newest question",
    });

    const itemsPage = await service.listItems("workspace-1", { limit: 10, offset: 0 });

    expect(itemsPage.total).toBe(3);
    expect(itemsPage.hasMore).toBe(false);
    expect(itemsPage.nextCursor).toBeNull();
    expect(itemsPage.items.map((item) => item.kind)).toEqual(["chat", "search", "chat"]);
    expect(itemsPage.items[0]).toMatchObject({
      kind: "chat",
      id: newestConversation.id,
      conversation: {
        messageCount: 1,
        preview: "Newest question",
      },
    });
    expect(itemsPage.items[1]).toMatchObject({
      kind: "search",
      id: "11111111-1111-4111-8111-111111111111",
      search: {
        query: "course calendar",
        resultCount: 2,
        traceAvailable: true,
        previewTopTitles: ["Course Calendar", "Workshop Notes"],
      },
    });
  });

  it("applies offset pagination to the merged history items", async () => {
    const { conversationRepository, auditRepository, service } = createService();
    const first = await conversationRepository.create("workspace-1");
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
    const third = await conversationRepository.create("workspace-1");
    third.updatedAt = new Date("2026-04-21T10:00:00.000Z");

    const itemsPage = await service.listItems("workspace-1", { limit: 1, offset: 1 });

    expect(itemsPage.total).toBe(3);
    expect(itemsPage.hasMore).toBe(true);
    expect(itemsPage.items).toHaveLength(1);
    expect(itemsPage.items[0]).toMatchObject({
      kind: "search",
      id: "44444444-4444-4444-8444-444444444444",
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

    const conversation = await conversationRepository.create("workspace-1");
    conversation.updatedAt = new Date("2026-04-21T10:00:00.000Z");
    await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "user",
      content: "Can I speak with a person?",
    });
    const assistant = await messageRepository.create({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      role: "assistant",
      content: "I can collect that request.",
    });

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
      "I can collect that request.",
      "Can I speak with a person?",
    ]);
  });
});
