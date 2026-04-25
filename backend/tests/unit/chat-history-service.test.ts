import { describe, expect, it } from "vitest";

import { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import {
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

describe("chat history service", () => {
  it("replays retrieval trace metadata for assistant turns", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const service = new ChatHistoryService(conversationRepository, messageRepository, auditRepository);

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
        answerSupportPolicy: "strict",
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
          answerSupportPolicy: "strict",
          hiddenSupportUsed: true,
          hiddenSupportKindsUsed: ["assistant_name", "assistant_role"],
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
    expect(debug?.retrievalTrace).toMatchObject({
      traceId: "trace-1",
      stages: [
        expect.objectContaining({ stageId: "trigger_analysis" }),
        expect.objectContaining({ stageId: "answer" }),
      ],
    });
    expect(debug?.answerOutcome).toBe("grounded_degraded_unsupported_segments");
    expect(debug?.answerSupportPolicy).toBe("strict");
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
      answerSupportPolicy: "strict",
      hiddenSupportUsed: true,
      hiddenSupportKindsUsed: ["assistant_name", "assistant_role"],
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
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditRepository = new InMemoryAuditEventRepository();
    const service = new ChatHistoryService(conversationRepository, messageRepository, auditRepository);

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
});
