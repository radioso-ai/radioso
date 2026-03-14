import { describe, expect, it } from "vitest";

import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { createAuditService, InMemoryConversationRepository, InMemoryMessageRepository } from "../support/fakes.js";

describe("chat service streaming", () => {
  it("persists the full assistant answer only after the stream completes", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const auditService = createAuditService();
    const retrievalPipeline = {
      async run() {
        return {
          rewrittenQuery: "what does this page do",
          contexts: [{ chunkId: "chunk-1" }],
          prompt: "prompt text",
          citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "skipped",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: false,
          },
        };
      },
    } as const;
    const chatGateway: ChatGateway = {
      async answer() {
        return "full answer";
      },
      async *streamAnswer() {
        yield "full ";
        yield "answer";
      },
    };
    const service = new ChatService(
      conversationRepository,
      messageRepository,
      retrievalPipeline as never,
      chatGateway,
      auditService,
    );

    const events: Array<{ type: string; text?: string; citations?: unknown[] }> = [];

    for await (const event of service.streamAnswer({
      accountId: "account-1",
      query: "What does this page do?",
      stream: true,
    })) {
      events.push(event);

      if (event.type === "chunk") {
        const [conversationId] = conversationRepository.items.keys();
        const persisted = await messageRepository.listByConversationId(conversationId!);
        expect(persisted.map((message) => message.role)).toEqual(["user"]);
      }
    }

    expect(events).toEqual([
      { type: "conversation", conversationId: expect.any(String) },
      { type: "chunk", text: "full " },
      { type: "chunk", text: "answer" },
      {
        type: "done",
        conversationId: expect.any(String),
        citations: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Intro" }],
      },
    ]);

    const [conversationId] = conversationRepository.items.keys();
    const persisted = await messageRepository.listByConversationId(conversationId!);
    expect(persisted.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "What does this page do?" },
      { role: "assistant", content: "full answer" },
    ]);
  });
});
