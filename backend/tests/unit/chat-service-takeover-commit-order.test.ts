import { describe, expect, it, vi } from "vitest";

import { createConversationEngine } from "@radioso/conversation-engine";
import {
  ChatService,
  type ChatGateway,
  type ChatServiceOptions,
  type ChatStreamEvent,
} from "../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { SkillOutcomeCapabilityProvider } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { AnswerCoverageHeadRecorder } from "../../src/modules/chat/services/answerCoverageHeadRecorder.js";
import { COMPLETION_NOTIFY_ACTION_TYPE } from "../../src/modules/chat/services/routines/contactRoutine.js";
import { StaticActionCapabilityMap } from "../../src/shared/domain/actionCapabilities.js";
import { StrictCapabilityPolicy, capabilityNames } from "../../src/shared/domain/capabilityPolicy.js";
import {
  createAuditService,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
  publishedRevisionResolverFixture,
} from "../support/fakes.js";

/**
 * Regression coverage for the takeover-reply-after-commit bug: when a coverage
 * routine (#1260) takes over a grounded turn and that takeover carries a durable
 * effect (an outbox action, an ownership handoff, a routine-ending notice), the
 * visitor must never read the routine's confirmation text before the effect is
 * durably committed. These tests drive the real engine's coverage-routine
 * activation end to end through `ChatService`, the same path production uses,
 * rather than faking the turn-assembly seam.
 */

const groundedSkillCapabilities: SkillOutcomeCapabilityProvider = {
  supportsGroundedAnswer: () => true,
};

const neverCalledFallbackReplyComposer: FallbackReplyComposer = {
  async composeNoContext() {
    throw new Error("composeNoContext should not run once the coverage routine yields the turn");
  },
};

const neverCalledChatGateway: ChatGateway = {
  async answer() {
    throw new Error("chatGateway.answer should not run once the coverage routine yields the turn");
  },
  async *streamAnswer() {
    throw new Error("chatGateway.streamAnswer should not run once the coverage routine yields the turn");
  },
};

/**
 * Wraps a bare retrieval `.run()` result into the interpret/runInterpreted/
 * runWithoutRetrieval shape `ChatSessionPreparer` expects (mirrors the helper in
 * chat-service-streaming.test.ts).
 */
const asChatActivityPipeline = (pipeline: { run(): Promise<unknown> }) => ({
  async interpret(input: { workspaceId: string; query: string; history: unknown[] }) {
    return {
      request: input,
      traceStartedAtMs: Date.now(),
      context: {
        startedAt: Date.now(),
        durationMs: 1,
        result: {
          request: input,
          settings: {
            workspaceId: input.workspaceId,
            queryRewriteEnabled: true,
            semanticRewriteInstructions: "",
            lexicalRewriteInstructions: "",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.1,
            rerankTopK: 5,
            citationDisplayEnabled: true,
            customInstruction: "",
            metadataRules: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          contextWindow: { selectedMessages: [], truncated: false, selectionReason: "full-history" },
        },
      },
      interpretation: { startedAt: Date.now(), durationMs: 1, result: {} },
    };
  },
  async runInterpreted(interpretation: { request: unknown }) {
    return (pipeline.run as (input: unknown) => unknown)(interpretation.request);
  },
  async runWithoutRetrieval() {
    throw new Error("runWithoutRetrieval should not be used for retrieval-route turns");
  },
});

/** Zero retrieved contexts, so the retrieval skill reports a deterministic zero-evidence
 * coverage verdict instead of calling a model — the coverage routine can then claim the
 * turn without any grounded-answer generation ever running. */
const zeroContextPipeline = () => ({
  async run() {
    return {
      rewrittenQuery: "missing topic",
      contexts: [],
      prompt: "prompt text",
      citations: [],
      diagnostics: {
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        parsedQuery: { semanticQuery: "missing topic", lexicalQuery: "missing topic" },
      },
      responseSettings: { citationDisplayEnabled: true },
    };
  },
} as const);

/** A direct-route pipeline: `runWithoutRetrieval` is the method the direct route actually
 * dispatches through (retrieval is skipped, not interpreted), unlike the retrieval-route
 * fixture above. */
const directRoutePipeline = () => ({
  async runWithoutRetrieval() {
    return {
      rewrittenQuery: "hello",
      contexts: [],
      prompt: "",
      citations: [],
      responseSettings: { citationDisplayEnabled: true },
      diagnostics: {
        rewriteStatus: "skipped",
        rerankStatus: "skipped",
        originalCandidateCount: 0,
        rewrittenCandidateCount: 0,
        lexicalCandidateCount: 0,
        normalizedCandidateCount: 0,
        finalContextCount: 0,
        candidateFallbackApplied: false,
        fallbackApplied: false,
        retrievalSkipped: true,
        parsedQuery: { semanticQuery: "hello", lexicalQuery: "hello" },
      },
    };
  },
  async interpret(input: { workspaceId: string; query: string; history: unknown[] }) {
    return {
      request: input,
      traceStartedAtMs: Date.now(),
      context: {
        startedAt: Date.now(),
        durationMs: 1,
        result: {
          request: input,
          settings: {
            workspaceId: input.workspaceId,
            queryRewriteEnabled: true,
            semanticRewriteInstructions: "",
            lexicalRewriteInstructions: "",
            suggestedQuestionsEnabled: true,
            suggestedQuestionsCount: 3,
            rerankEnabled: false,
            vectorTopK: 20,
            similarityThreshold: 0.1,
            rerankTopK: 5,
            citationDisplayEnabled: true,
            customInstruction: "",
            metadataRules: [],
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          contextWindow: { selectedMessages: [], truncated: false, selectionReason: "full-history" },
        },
      },
      interpretation: { startedAt: Date.now(), durationMs: 1, result: {} },
    };
  },
  async runInterpreted() {
    throw new Error("runInterpreted should not be used for a direct-route turn");
  },
} as const);

interface CoverageTakeoverEnding {
  answer: string;
  terminal: { kind: "complete" | "handoff"; stepId: string; operatorNotice?: Record<string, unknown> };
}

/** A coverage-routine provider that always activates "support" post-evidence and resumes
 * straight to the given ending — the same shape production's coverage activator/runner
 * ports present, pared to what these tests need to control. */
const coverageTakeoverRoutineProvider = (ending: CoverageTakeoverEnding): NonNullable<ChatServiceOptions["routineProvider"]> => ({
  async forTurn() {
    return {
      activator: { activate: async () => null },
      coverageActivator: {
        evaluateCandidates: () => [
          { routineId: "support", decision: "candidate" as const, reasonCode: "coverage_criteria_candidate" },
        ],
        activate: async () => ({ kind: "activate" as const, routineId: "support" }),
      },
      runner: {
        resume: async () => ({
          response: { answer: ending.answer },
          nextState: null,
          terminal: ending.terminal,
        }),
      },
    };
  },
});

const buildTakeoverService = (input: {
  ending: CoverageTakeoverEnding;
  actionOutbox?: NonNullable<ChatServiceOptions["actionOutbox"]>;
  actionCapabilities?: ChatServiceOptions["actionCapabilities"];
  capabilityPolicy?: ChatServiceOptions["capabilityPolicy"];
}) => {
  const conversationRepository = new InMemoryConversationRepository();
  const messageRepository = new InMemoryMessageRepository();
  const auditService = createAuditService();
  const routineStore: NonNullable<ChatServiceOptions["routineStore"]> = {
    loadActive: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
  const service = new ChatService({
    conversationRepository,
    messageRepository,
    retrievalTurn: new RetrievalTurnController(asChatActivityPipeline(zeroContextPipeline()) as never),
    chatGateway: neverCalledChatGateway,
    auditService,
    turnRuntime: buildChatTurnRuntime({
      chatGateway: neverCalledChatGateway,
      fallbackReplyComposer: neverCalledFallbackReplyComposer,
      skillOutcomeCapabilities: groundedSkillCapabilities,
    }),
    turnRouter: {
      async classify() {
        return { route: "retrieval" as const, framing: { isIdentityQuestion: false } };
      },
    },
    conversationEngine: createConversationEngine(),
    agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    // A recorder with no backing repository passes `wrapVerdictSink` through
    // unchanged (no persistence needed for these tests) while still being
    // present, which is what gates chatTurnAssembly's coverage-routine wiring.
    coverageHeadRecorder: new AnswerCoverageHeadRecorder(),
    routineStore,
    routineProvider: coverageTakeoverRoutineProvider(input.ending),
    actionOutbox: input.actionOutbox,
    actionCapabilities: input.actionCapabilities,
    capabilityPolicy: input.capabilityPolicy,
  });
  return { service, messageRepository };
};

const drain = async (
  stream: AsyncIterable<ChatStreamEvent>,
  onChunk: () => void,
): Promise<ChatStreamEvent[]> => {
  const events: ChatStreamEvent[] = [];
  for await (const event of stream) {
    if (event.type === "chunk") {
      onChunk();
    }
    events.push(event);
  }
  return events;
};

describe("chat service: takeover reply released only after its effect commits", () => {
  it("holds a coverage takeover's confirmation until its action is durably enqueued", async () => {
    const chunkObserved = vi.fn();
    const enqueue = vi.fn(async () => ({ id: "action-1", duplicate: false }));
    const { service, messageRepository } = buildTakeoverService({
      ending: {
        answer: "Thanks, I've sent this to our team.",
        terminal: { kind: "complete", stepId: "end", operatorNotice: {} },
      },
      actionOutbox: { enqueue },
    });
    const createMessage = vi.spyOn(messageRepository, "create");

    const events = await drain(
      service.streamAnswer({ workspaceId: "workspace-1", query: "missing topic", stream: true }),
      chunkObserved,
    );

    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks.map((event) => (event as { text: string }).text)).toEqual([
      "Thanks, I've sent this to our team.",
    ]);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: COMPLETION_NOTIFY_ACTION_TYPE }),
    );
    expect(chunkObserved).toHaveBeenCalledOnce();
    // One `create` call persists the visitor's message, the other the assistant's
    // reply; the reply is always the later of the two.
    expect(createMessage).toHaveBeenCalledTimes(2);
    // The action must be durably enqueued, and the assistant message persisted,
    // strictly before the visitor-facing chunk is released.
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(chunkObserved.mock.invocationCallOrder[0]);
    expect(createMessage.mock.invocationCallOrder[1]).toBeLessThan(chunkObserved.mock.invocationCallOrder[0]);
  });

  it("shows nothing and surfaces the error when the takeover's action is denied", async () => {
    const chunkObserved = vi.fn();
    const enqueue = vi.fn(async () => ({ id: "action-1", duplicate: false }));
    const { service, messageRepository } = buildTakeoverService({
      ending: {
        answer: "Thanks, I've sent this to our team.",
        terminal: { kind: "complete", stepId: "end", operatorNotice: {} },
      },
      actionOutbox: { enqueue },
      actionCapabilities: new StaticActionCapabilityMap([
        { type: COMPLETION_NOTIFY_ACTION_TYPE, requiredCapabilities: [capabilityNames.humanContact.request] },
      ]),
      capabilityPolicy: new StrictCapabilityPolicy({ deniedCapabilities: [capabilityNames.humanContact.request] }),
    });
    const createMessage = vi.spyOn(messageRepository, "create");

    await expect(
      drain(
        service.streamAnswer({ workspaceId: "workspace-1", query: "missing topic", stream: true }),
        chunkObserved,
      ),
    ).rejects.toThrow();

    expect(chunkObserved).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    // The inbound visitor message is recorded during session preparation regardless of
    // how the turn later resolves; the assistant's reply must never be, since the denial
    // throws inside `completeAssistantTurn`, before it persists anything.
    expect(createMessage).not.toHaveBeenCalledWith(expect.objectContaining({ role: "assistant" }));
  });

  it("keeps a takeover without a durable effect streaming its confirmation before persistence", async () => {
    const chunkObserved = vi.fn();
    const { service, messageRepository } = buildTakeoverService({
      ending: {
        answer: "Here's a quick answer without any follow-up action.",
        terminal: { kind: "complete", stepId: "end" },
      },
    });
    const createMessage = vi.spyOn(messageRepository, "create");

    const events = await drain(
      service.streamAnswer({ workspaceId: "workspace-1", query: "missing topic", stream: true }),
      chunkObserved,
    );

    const chunks = events.filter((event) => event.type === "chunk");
    expect(chunks.map((event) => (event as { text: string }).text)).toEqual([
      "Here's a quick answer without any follow-up action.",
    ]);
    expect(chunkObserved).toHaveBeenCalledOnce();
    expect(createMessage).toHaveBeenCalledTimes(2);
    // Preserves today's ordering for a non-effect turn: the text streams before
    // the turn (the later of the two `create` calls, the assistant reply) is persisted.
    expect(chunkObserved.mock.invocationCallOrder[0]).toBeLessThan(createMessage.mock.invocationCallOrder[1]);
  });

  it("keeps a live grounded answer streaming before persistence", async () => {
    const conversationRepository = new InMemoryConversationRepository();
    const messageRepository = new InMemoryMessageRepository();
    const createMessage = vi.spyOn(messageRepository, "create");
    const auditService = createAuditService();
    const chunkObserved = vi.fn();
    const chatGateway: ChatGateway = {
      async answer() {
        return "Hello there.";
      },
      async *streamAnswer() {
        yield "Hello ";
        yield "there.";
      },
    };
    const service = new ChatService({
      conversationRepository,
      messageRepository,
      retrievalTurn: new RetrievalTurnController(directRoutePipeline() as never),
      chatGateway,
      auditService,
      turnRuntime: buildChatTurnRuntime({
        chatGateway,
        fallbackReplyComposer: neverCalledFallbackReplyComposer,
        skillOutcomeCapabilities: groundedSkillCapabilities,
      }),
      turnRouter: {
        async classify() {
          return { route: "direct" as const, framing: { isIdentityQuestion: false } };
        },
      },
      conversationEngine: createConversationEngine(),
      agentRevisionRuntimeResolver: publishedRevisionResolverFixture(),
    });

    const events = await drain(
      service.streamAnswer({ workspaceId: "workspace-1", query: "hello", stream: true }),
      chunkObserved,
    );

    expect(events.filter((event) => event.type === "chunk")).toHaveLength(2);
    expect(chunkObserved).toHaveBeenCalledTimes(2);
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(chunkObserved.mock.invocationCallOrder[0]).toBeLessThan(createMessage.mock.invocationCallOrder[1]);
  });
});
