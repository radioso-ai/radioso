import { describe, expect, it, vi } from "vitest";

import type {
  ConversationClarificationStore,
  ConversationRoutineStore,
  PendingClarification,
} from "@radioso/conversation-contract";
import { createConversationEngine } from "@radioso/conversation-engine";

import { ChatService, type ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { RetrievalAnswerSkillExecutor } from "../../src/modules/retrieval/services/retrievalAnswerSkillExecutor.js";
import { noopSkillEmitPort } from "../../src/modules/skills/public.js";
import type {
  RetrievalPipelineRequest,
  RetrievalPipelineResult,
  RetrievalPipelineService,
} from "../../src/modules/retrieval/public.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import { MissingFallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import {
  createAuditService,
  InMemoryAuditEventRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";
import { hathaRajaYogaCandidates } from "../fixtures/retrievalSenseCorpus.js";

const answerEnvelope = (answer: string): string =>
  `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify({ grounding: "grounded", suggestions: [] })}`;

const retrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult => {
  const now = new Date().toISOString();
  const candidates = hathaRajaYogaCandidates().slice(0, 4);
  const scoped = request.documentScope?.length
    ? candidates.filter((candidate) => request.documentScope!.includes(candidate.documentId))
    : candidates;
  const contexts = scoped.map((candidate, index) => ({
    ...candidate,
    relevanceScore: candidate.similarity,
    rerankPosition: index,
    promptPosition: index + 1,
    estimatedTokenCost: 10,
  }));
  return {
    rewrittenQuery: request.query,
    contexts,
    systemPrompt: "Answer with citations.",
    prompt: contexts.map((context, index) => `[[${index + 1}]] ${context.title}`).join("\n"),
    citations: contexts.map((context) => ({ documentId: context.documentId, chunkId: context.chunkId, title: context.title })),
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
    },
    diagnostics: {
      execution: { surface: "assistant", path: "assistant_retrieval", retrievalInvoked: true },
      rewriteStatus: "skipped",
      rerankStatus: "skipped",
      originalCandidateCount: 0,
      rewrittenCandidateCount: contexts.length,
      lexicalCandidateCount: 0,
      normalizedCandidateCount: contexts.length,
      finalContextCount: contexts.length,
      retrievalSkipped: false,
      candidateFallbackApplied: false,
      fallbackApplied: false,
      rewriteEligible: true,
      rewriteRan: false,
      materialDisagreement: false,
      triggerAnalysis: {
        status: "skipped_not_configured",
        consideredRules: [],
        matchedRuleIds: [],
        unmatchedRuleIds: [],
        matchCount: 0,
        matcherVersion: "none",
      },
    },
    trace: {
      traceId: `trace-${request.query}`,
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [{
        stageId: "candidate_preparation",
        kind: "candidate_preparation",
        label: "Candidate preparation",
        status: "applied",
        startedAt: now,
        outputs: { candidateCount: contexts.length },
      }],
      links: [],
    },
  };
};

const retrievalTurn = (capturedRequests: RetrievalPipelineRequest[] = []): RetrievalTurnController => {
  const pipeline: RetrievalPipelineService = {
    async run(input) {
      capturedRequests.push(input);
      return retrievalResult(input);
    },
    async interpret(input) {
      capturedRequests.push(input);
      return {
        request: input,
        traceStartedAtMs: Date.now(),
        context: { result: {} as never, startedAt: 0, durationMs: 0 },
        interpretation: {
          result: {
            request: input,
            responseIntent: "retrieval",
          } as never,
          startedAt: 0,
          durationMs: 0,
        },
      } as never;
    },
    async runInterpreted(input) {
      capturedRequests.push(input.request);
      return retrievalResult(input.request);
    },
    async runWithoutRetrieval(input) {
      capturedRequests.push(input.request);
      return retrievalResult(input.request);
    },
  };
  return new RetrievalTurnController(pipeline);
};

const chatGateway: ChatGateway = {
  async answer() {
    return answerEnvelope("Grounded answer[[1]]");
  },
  async *streamAnswer() {
    yield answerEnvelope("Grounded answer[[1]]");
  },
};

const makeService = (input: {
  capturedRequests?: RetrievalPipelineRequest[];
  clarificationStore?: ConversationClarificationStore;
  routineStore?: ConversationRoutineStore;
  detector?: { detect: ReturnType<typeof vi.fn> };
  route?: "retrieval" | "direct";
}) => new ChatService({
  conversationRepository: new InMemoryConversationRepository(),
  messageRepository: new InMemoryMessageRepository(),
  retrievalTurn: retrievalTurn(input.capturedRequests),
  chatGateway,
  // Most scenarios exercise grounded turns, so route every turn to retrieval by
  // default. A resolving retrieval-sense turn ("hatha") can route direct, so a
  // test overrides this to assert the resolved sense still forces retrieval.
  turnRouter: {
    async classify() {
      return { route: input.route ?? "retrieval", framing: { isIdentityQuestion: false } };
    },
  },
  auditService: createAuditService(new InMemoryAuditEventRepository()),
  turnRuntime: buildChatTurnRuntime({
    chatGateway,
    fallbackReplyComposer: new MissingFallbackReplyComposer(),
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
  }),
  conversationEngine: createConversationEngine(),
  clarificationStore: input.clarificationStore,
  clarifier: {
    phraseQuestion: vi.fn(async () => "Which yoga sense do you mean?"),
    mapReply: vi.fn(async () => ({ kind: "chosen" as const, id: "doc-hatha" })),
  },
  retrievalSenseDetector: input.detector as never,
  retrievalSenseClarificationPolicy: { floor: 0, margin: 0.15, maxOptions: 4 },
  routineStore: input.routineStore,
  routineProvider: input.routineStore
    ? { async forTurn() {
        return {
          activator: { async activate() { return null; } },
          runner: { async resume() { return { yielded: true, response: { answer: "" }, nextState: null }; } },
        };
      } }
    : undefined,
});

describe("retrieval sense clarification", () => {
  it("asks instead of composing a grounded answer and stores pending retrieval_sense candidates", async () => {
    let saved: PendingClarification | null = null;
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.58, payload: { documentIds: ["doc-raja"] } },
      ]),
    };
    const service = makeService({
      detector,
      clarificationStore: {
        loadPending: vi.fn(async () => null),
        save: vi.fn(async (pending) => { saved = pending; }),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "tell me about yoga",
      stream: false,
    });

    expect(response.answer).toBe("Which yoga sense do you mean?");
    expect(saved).toMatchObject({
      source: "retrieval_sense",
      candidates: [
        expect.objectContaining({ id: "doc-hatha", payload: { documentIds: ["doc-hatha"] } }),
        expect.objectContaining({ id: "doc-raja", payload: { documentIds: ["doc-raja"] } }),
      ],
      status: "pending",
    });
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({ surface: "retrieval_sense", decision: "asked" }),
      }),
    ]));
  });

  it("applies resolved retrieval_sense documentScope to the resolving retrieval turn", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const service = makeService({
      capturedRequests,
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          sessionId: "conv-1",
          source: "retrieval_sense",
          candidates: [
            { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
            { id: "doc-raja", label: "Raja yoga", confidence: 0.58, payload: { documentIds: ["doc-raja"] } },
          ],
          status: "pending" as const,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        })),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "hatha",
      stream: false,
    });

    expect(capturedRequests.some((request) => request.documentScope?.includes("doc-hatha"))).toBe(true);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
  });

  it("forces grounded retrieval scoped to the resolved sense even when the router answers direct", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const service = makeService({
      capturedRequests,
      // The short sense answer routes direct; the resolved sense must still ground.
      route: "direct",
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          sessionId: "conv-1",
          source: "retrieval_sense",
          candidates: [
            { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
            { id: "doc-raja", label: "Raja yoga", confidence: 0.58, payload: { documentIds: ["doc-raja"] } },
          ],
          status: "pending" as const,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        })),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "the first one",
      stream: false,
    });

    expect(capturedRequests.some((request) => request.documentScope?.includes("doc-hatha"))).toBe(true);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
  });

  it("suppresses asking while an active routine has yielded and records a suppressed decision", async () => {
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.58, payload: { documentIds: ["doc-raja"] } },
      ]),
    };
    const service = makeService({
      detector,
      clarificationStore: {
        loadPending: vi.fn(async () => null),
        save: vi.fn(),
        clear: vi.fn(),
      },
      routineStore: {
        loadActive: vi.fn(async () => ({
          sessionId: "conv-1",
          routineId: "routine-1",
          path: ["step-1"],
          variables: {},
          status: "active" as const,
        })),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "tell me about yoga",
      stream: false,
    });

    expect(response.answer).toBe("Grounded answer");
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({ surface: "retrieval_sense", decision: "suppressed" }),
      }),
    ]));
  });

  it("does not invoke retrieval sense detection for standalone retrieval.answer execution", async () => {
    const detector = { detect: vi.fn() };
    const pipeline = {
      run: vi.fn(async (request: RetrievalPipelineRequest) => retrievalResult(request)),
      interpret: vi.fn(),
      runInterpreted: vi.fn(),
      runWithoutRetrieval: vi.fn(),
    };
    const executor = new RetrievalAnswerSkillExecutor(pipeline as never);

    await executor.dispatch({
      skill: { name: "retrieval.answer" },
      collected: {},
      context: {
        request: {
          workspaceId: "workspace-1",
          query: "tell me about yoga",
          history: [],
        },
      },
      emit: noopSkillEmitPort,
    });

    expect(pipeline.run).toHaveBeenCalled();
    expect(detector.detect).not.toHaveBeenCalled();
  });
});
