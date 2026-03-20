import { describe, expect, it } from "vitest";

import { ChatService, type ChatGateway, type ChatStreamEvent } from "../../src/modules/chat/services/chatService.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { createAuditService, InMemoryConversationRepository, InMemoryMessageRepository } from "../support/fakes.js";

const zeroContextDiagnostics = {
  rewriteStatus: "skipped" as const,
  rerankStatus: "skipped" as const,
  originalCandidateCount: 0,
  rewrittenCandidateCount: 0,
  lexicalCandidateCount: 0,
  normalizedCandidateCount: 0,
  finalContextCount: 0,
  candidateFallbackApplied: false,
  fallbackApplied: false,
  parsedQuery: {
    semanticQuery: "capital of france",
    lexicalQuery: "capital of france",
    constraints: [],
  },
};

function createZeroContextPipeline(overrides?: { inferenceAnswerEnabled?: boolean; customInstruction?: string }) {
  return {
    async run() {
      return {
        rewrittenQuery: "capital of france",
        contexts: [],
        prompt: "",
        citations: [],
        responseSettings: {
          warmthLevel: 5,
          citationDisplayEnabled: true,
          inferenceAnswerEnabled: overrides?.inferenceAnswerEnabled ?? false,
          customInstruction: overrides?.customInstruction ?? "",
        },
        diagnostics: zeroContextDiagnostics,
      };
    },
  } as const;
}

describe("inference fallback", () => {
  describe("PromptBuilder.buildInferencePrompt", () => {
    const builder = new PromptBuilder();

    it("omits Retrieved Context section and citation markers", () => {
      const prompt = builder.buildInferencePrompt({
        query: "What is the capital of France?",
        history: [],
        settings: { warmthLevel: 5 },
      });

      expect(prompt).not.toContain("Retrieved Context");
      expect(prompt).not.toContain("Cite any claim grounded in a retrieved result using [[n]]");
      expect(prompt).toContain("Do not use citation markers like [[n]]");
      expect(prompt).toContain("What is the capital of France?");
      expect(prompt).toContain("Answer from your general knowledge");
    });

    it("includes warmth instruction", () => {
      const prompt = builder.buildInferencePrompt({
        query: "test",
        history: [],
        settings: { warmthLevel: 9 },
      });

      expect(prompt).toContain("warm, considerate tone");
    });

    it("includes custom instruction when provided", () => {
      const prompt = builder.buildInferencePrompt({
        query: "test",
        history: [],
        settings: { warmthLevel: 5, customInstruction: "Always respond in French" },
      });

      expect(prompt).toContain("Workspace-specific instructions:");
      expect(prompt).toContain("Always respond in French");
    });

    it("omits custom instruction block when not provided", () => {
      const prompt = builder.buildInferencePrompt({
        query: "test",
        history: [],
        settings: { warmthLevel: 5 },
      });

      expect(prompt).not.toContain("Workspace-specific instructions:");
    });

    it("includes conversation history", () => {
      const prompt = builder.buildInferencePrompt({
        query: "Tell me more",
        history: [
          { id: "m1", conversationId: "c1", workspaceId: "w1", role: "user", content: "Hello", createdAt: new Date() },
          { id: "m2", conversationId: "c1", workspaceId: "w1", role: "assistant", content: "Hi there", createdAt: new Date() },
        ],
        settings: { warmthLevel: 5 },
      });

      expect(prompt).toContain("USER: Hello");
      expect(prompt).toContain("ASSISTANT: Hi there");
    });
  });

  describe("ChatService with inference enabled", () => {
    it("returns an inference answer when no contexts match and inference is enabled (non-streaming)", async () => {
      const auditService = createAuditService();
      const chatGateway: ChatGateway = {
        async answer() {
          return "Paris is the capital of France. Note: this answer is from general knowledge.";
        },
        async *streamAnswer() {
          yield "Paris is the capital of France.";
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: true }) as never,
        chatGateway,
        auditService,
      );

      const result = await service.answer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: false,
      });

      expect(result.source).toBe("inference");
      expect(result.answer).toContain("Paris");
      expect(result.citations).toBeUndefined();
    });

    it("returns an inference answer when no contexts match and inference is enabled (streaming)", async () => {
      const auditService = createAuditService();
      const chatGateway: ChatGateway = {
        async answer() {
          return "Paris is the capital.";
        },
        async *streamAnswer() {
          yield "Paris is ";
          yield "the capital.";
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: true }) as never,
        chatGateway,
        auditService,
      );

      const events: ChatStreamEvent[] = [];
      for await (const event of service.streamAnswer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: true,
      })) {
        events.push(event);
      }

      const doneEvent = events.find((e): e is Extract<ChatStreamEvent, { type: "done" }> => e.type === "done");
      expect(doneEvent?.source).toBe("inference");
      expect(doneEvent?.answer).toBe("Paris is the capital.");

      const chunks = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text);
      expect(chunks.join("")).toBe("Paris is the capital.");
    });

    it("returns static message when inference is disabled and no contexts match", async () => {
      const auditService = createAuditService();
      const chatGateway: ChatGateway = {
        async answer() {
          return "should not be called";
        },
        async *streamAnswer() {
          yield "should not be called";
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: false }) as never,
        chatGateway,
        auditService,
      );

      const result = await service.answer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: false,
      });

      expect(result.source).toBe("retrieval");
      expect(result.answer).toBe("I could not find relevant information in your documents.");
    });
  });

  describe("ChatService inference failure handling", () => {
    it("falls back to static message and audits the failure (non-streaming)", async () => {
      const auditService = createAuditService();
      const chatGateway: ChatGateway = {
        async answer() {
          throw new Error("LLM service unavailable");
        },
        async *streamAnswer() {
          throw new Error("LLM service unavailable");
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: true }) as never,
        chatGateway,
        auditService,
      );

      const result = await service.answer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: false,
      });

      expect(result.source).toBe("retrieval");
      expect(result.answer).toBe("I could not find relevant information in your documents.");

      const failureEvent = auditService.events.find(
        (e) => e.eventStatus === "failure" && (e.metadata as Record<string, unknown>)?.stage === "inference_fallback",
      );
      expect(failureEvent).toBeDefined();
      expect((failureEvent!.metadata as Record<string, unknown>).errorMessage).toBe("LLM service unavailable");
    });

    it("falls back to static message and audits the failure (streaming)", async () => {
      const auditService = createAuditService();
      const chatGateway: ChatGateway = {
        async answer() {
          throw new Error("LLM service unavailable");
        },
        async *streamAnswer() {
          throw new Error("LLM service unavailable");
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: true }) as never,
        chatGateway,
        auditService,
      );

      const events: ChatStreamEvent[] = [];
      for await (const event of service.streamAnswer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: true,
      })) {
        events.push(event);
      }

      const doneEvent = events.find((e): e is Extract<ChatStreamEvent, { type: "done" }> => e.type === "done");
      expect(doneEvent?.source).toBe("retrieval");
      expect(doneEvent?.answer).toBe("I could not find relevant information in your documents.");

      const failureEvent = auditService.events.find(
        (e) => e.eventStatus === "failure" && (e.metadata as Record<string, unknown>)?.stage === "inference_fallback",
      );
      expect(failureEvent).toBeDefined();
      expect((failureEvent!.metadata as Record<string, unknown>).errorMessage).toBe("LLM service unavailable");
    });
  });

  describe("ChatService passes custom instruction to inference prompt", () => {
    it("includes workspace custom instruction in the inference prompt", async () => {
      const auditService = createAuditService();
      let capturedPrompt = "";
      const chatGateway: ChatGateway = {
        async answer(input) {
          capturedPrompt = input.prompt;
          return "Answer in French: Paris est la capitale.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      };
      const service = new ChatService(
        new InMemoryConversationRepository(),
        new InMemoryMessageRepository(),
        createZeroContextPipeline({ inferenceAnswerEnabled: true, customInstruction: "Always respond in French" }) as never,
        chatGateway,
        auditService,
      );

      await service.answer({
        workspaceId: "workspace-1",
        query: "What is the capital of France?",
        stream: false,
      });

      expect(capturedPrompt).toContain("Always respond in French");
    });
  });
});
