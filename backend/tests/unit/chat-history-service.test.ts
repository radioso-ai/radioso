import { describe, expect, it } from "vitest";

import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type {
  ContactHistoryDetail,
  ContactHistoryProviderPort,
  ContactHistorySummary,
} from "../../src/modules/chat/services/contactHistoryProvider.js";
import {
  InMemoryAuditEventRepository,
  InMemoryConversationOwnershipRepository,
  InMemoryConversationRepository,
  InMemoryHistoryItemsRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const createService = () => {
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
    service: new ChatHistoryService(
      conversationRepository,
      messageRepository,
      auditRepository,
      historyItemsRepository,
      undefined,
      undefined,
      conversationOwnershipRepository,
    ),
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

describe("chat history service ownership read surface", () => {
  it("includes ownership in conversation detail when the conversation is human-owned", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const conversation = await conversationRepository.create("workspace-1");
    await conversationOwnershipRepository.requestHandoff({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      reason: "routine_handoff",
    });
    await conversationOwnershipRepository.takeOver({
      conversationId: conversation.id,
      workspaceId: "workspace-1",
      accountId: "operator-1",
      displayName: "Operator One",
    });

    const detail = await service.getConversation("workspace-1", conversation.id);

    expect(detail.ownership).toMatchObject({
      conversationId: conversation.id,
      state: "human_owned",
      ownerAccountId: "operator-1",
      ownerDisplayName: "Operator One",
    });
    expect(typeof detail.ownership?.takenOverAt).toBe("string");
  });

  it("omits ownership from detail when the conversation is AI-owned (no row)", async () => {
    const { conversationRepository, service } = createService();
    const conversation = await conversationRepository.create("workspace-1");

    const detail = await service.getConversation("workspace-1", conversation.id);

    expect(detail.ownership).toBeUndefined();
  });

  it("includes ownership per row in the conversation list, omitting AI-owned ones", async () => {
    const { conversationRepository, conversationOwnershipRepository, service } = createService();
    const human = await conversationRepository.create("workspace-1");
    const ai = await conversationRepository.create("workspace-1");
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
});

describe("chat history service", () => {
  it("replays activity trace metadata for assistant turns", async () => {
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

    const conversation = await conversationRepository.create("workspace-1");
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

    const conversation = await conversationRepository.create("workspace-1");
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

  it("preserves provider-defined suggestion kinds and action payloads on reload", async () => {
    const { conversationRepository, messageRepository, auditRepository, service } = createService();

    const conversation = await conversationRepository.create("workspace-1");
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

    const conversation = await conversationRepository.create("workspace-1");
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

    const conversation = await conversationRepository.create("workspace-1");
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

    const conversation = await conversationRepository.create("workspace-1");
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

    const conversation = await conversationRepository.create("workspace-1");
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
        activityTrace: {
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
        activityTraceAvailable: true,
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
