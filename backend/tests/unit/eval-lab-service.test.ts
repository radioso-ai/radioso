import { describe, expect, it } from "vitest";

import { EvalLabService, type EvalRepositoryPort } from "../../src/modules/evals/services/evalLabService.js";
import type { ChatHistoryService } from "../../src/modules/chat/services/chatHistoryService.js";
import type { EvalReplayService } from "../../src/modules/evals/services/evalReplayService.js";

const createRepositoryStub = (): EvalRepositoryPort => ({
  listDatasets: async () => [],
  createDataset: async () => {
    throw new Error("not used");
  },
  findDatasetById: async () => null,
  listCases: async () => [],
  createCase: async () => {
    throw new Error("not used");
  },
  listRuns: async () => [],
  createRun: async () => {
    throw new Error("not used");
  },
  findRunById: async () => null,
});

describe("EvalLabService", () => {
  it("imports a conversation turn without crashing when historical citations are malformed", async () => {
    const chatHistoryService = {
      getConversation: async () => ({
        conversationId: "conversation-1",
        workspaceId: "workspace-1",
        sourceChannel: null,
        createdAt: "2026-04-02T00:00:00.000Z",
        updatedAt: "2026-04-02T00:00:00.000Z",
        messageCount: 2,
        userMessageCount: 1,
        assistantMessageCount: 1,
        messagesTotal: 2,
        messageWindowOffset: 0,
        messageWindowLimit: 200,
        hasOlderMessages: false,
        messages: [
          {
            id: "user-1",
            role: "user" as const,
            content: "Which cookie name is used for browser sessions?",
            createdAt: "2026-04-02T00:00:00.000Z",
          },
          {
            id: "assistant-1",
            role: "assistant" as const,
            content: "radioso_session",
            createdAt: "2026-04-02T00:00:01.000Z",
            citations: { legacy: true } as any,
            debug: undefined,
          },
        ],
      }),
    } as unknown as ChatHistoryService;

    const service = new EvalLabService(
      createRepositoryStub(),
      chatHistoryService,
      {} as EvalReplayService,
    );

    await expect(
      service.importConversationTurn("workspace-1", {
        conversationId: "conversation-1",
        assistantMessageId: "assistant-1",
      }),
    ).resolves.toMatchObject({
      query: "Which cookie name is used for browser sessions?",
      seededExpectations: {
        expectedDocumentIds: [],
        expectedCitationTitles: [],
      },
      unavailable: ["retrievalTrace", "answerOutcome"],
    });
  });
});
