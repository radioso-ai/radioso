import { describe, expect, it, vi } from "vitest";

import type {
  ConversationClarificationStore,
  ConversationClarifier,
  ConversationRoutineStore,
  PendingClarification,
} from "@radioso/conversation-contract";
import { createConversationEngine } from "@radioso/conversation-engine";

import { ChatService, type ChatGateway, type ChatServiceOptions } from "../../src/modules/chat/services/chatService.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import { RetrievalTurnController } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import { RetrievalAnswerSkillExecutor } from "../../src/modules/retrieval/services/retrievalAnswerSkillExecutor.js";
import { noopSkillEmitPort } from "../../src/modules/skills/public.js";
import type { RouteScopedDirectiveRuntime } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import type { TurnRouterInput } from "../../src/modules/chat/services/turnRouter.js";
import type { DirectiveSteerInput } from "../../src/modules/directives/public.js";
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

const retrievalResult = (
  request: RetrievalPipelineRequest,
  options: { suggestedQuestionsEnabled?: boolean } = {},
): RetrievalPipelineResult => {
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
      suggestedQuestionsEnabled: options.suggestedQuestionsEnabled ?? false,
      suggestedQuestionsCount: options.suggestedQuestionsEnabled ? 3 : 0,
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

const retrievalTurn = (
  capturedRequests: RetrievalPipelineRequest[] = [],
  options: { suggestedQuestionsEnabled?: boolean } = {},
): RetrievalTurnController => {
  const pipeline: RetrievalPipelineService = {
    async run(input) {
      capturedRequests.push(input);
      return retrievalResult(input, options);
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
      return retrievalResult(input.request, options);
    },
    async runWithoutRetrieval(input) {
      capturedRequests.push(input.request);
      return retrievalResult(input.request, options);
    },
  };
  return new RetrievalTurnController(pipeline);
};

const chatGateway = (captures?: {
  answerInputs?: ChatGatewayInput[];
  streamInputs?: ChatGatewayInput[];
}): ChatGateway => ({
  async answer(input) {
    captures?.answerInputs?.push(input);
    return answerEnvelope("Grounded answer[[1]]");
  },
  async *streamAnswer(input) {
    captures?.streamInputs?.push(input);
    yield answerEnvelope("Grounded answer[[1]]");
  },
});

const makeService = (input: {
  capturedRequests?: RetrievalPipelineRequest[];
  clarificationStore?: ConversationClarificationStore;
  routineStore?: ConversationRoutineStore;
  detector?: { detect: ReturnType<typeof vi.fn> };
  mapReply?: ConversationClarifier["mapReply"];
  route?: "retrieval" | "direct";
  chatGateway?: ChatGateway;
  directiveRuntime?: RouteScopedDirectiveRuntime;
  messageRepository?: InMemoryMessageRepository;
  routerInputs?: TurnRouterInput[];
  suggestedQuestionsEnabled?: boolean;
  turnInterpreter?: ChatServiceOptions["turnInterpreter"];
}) => {
  const gateway = input.chatGateway ?? chatGateway();
  return new ChatService({
    conversationRepository: new InMemoryConversationRepository(),
    messageRepository: input.messageRepository ?? new InMemoryMessageRepository(),
    retrievalTurn: retrievalTurn(input.capturedRequests, {
      suggestedQuestionsEnabled: input.suggestedQuestionsEnabled,
    }),
    chatGateway: gateway,
    // Most scenarios exercise grounded turns, so route every turn to retrieval by
    // default. A resolving retrieval-sense turn ("hatha") can route direct, so a
    // test overrides this to assert the resolved sense still forces retrieval.
    turnRouter: {
      async classify(routerInput) {
        input.routerInputs?.push(routerInput);
        return { route: input.route ?? "retrieval", framing: { isIdentityQuestion: false } };
      },
    },
    auditService: createAuditService(new InMemoryAuditEventRepository()),
    turnRuntime: buildChatTurnRuntime({
      chatGateway: gateway,
      fallbackReplyComposer: new MissingFallbackReplyComposer(),
      skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    }),
    conversationEngine: createConversationEngine(),
    clarificationStore: input.clarificationStore,
    clarifier: {
      phraseQuestion: vi.fn(async () => "Which yoga sense do you mean?"),
      mapReply: input.mapReply ?? vi.fn(async () => ({ kind: "chosen" as const, id: "doc-hatha" })),
    },
    retrievalSenseDetector: input.detector as never,
    directiveSteering: input.directiveRuntime,
    turnInterpreter: input.turnInterpreter,
    retrievalSenseClarificationPolicy: { floor: 0, margin: 0.15, askMargin: 0.03, maxOptions: 4 },
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
};

const retrievalSensePending = (originalQuery: string): PendingClarification => ({
  sessionId: "conv-1",
  source: "retrieval_sense",
  originalQuery,
  mode: "ask",
  candidates: [
    { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
    { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
  ],
  status: "pending",
  expiresAt: new Date("2099-01-01T00:00:00.000Z"),
});

const captureDirectiveRuntime = (inputs: DirectiveSteerInput[]): RouteScopedDirectiveRuntime => ({
  matcher: {
    async match() {
      return [];
    },
  },
  directivesFor(input) {
    inputs.push(input);
    return [];
  },
  async matchAndResolve(input) {
    inputs.push(input);
    return { rules: [], matches: [], omissions: [] };
  },
  async resolveMatches(input) {
    inputs.push(input);
    return { rules: [], matches: [], omissions: [] };
  },
  async steer(input) {
    inputs.push(input);
    return { rules: [], matches: [], omissions: [] };
  },
});

describe("retrieval sense clarification", () => {
  it("answers with the strongest sense, offers alternatives in the answer prompt, and stores offer-mode pending candidates", async () => {
    let saved: PendingClarification | null = null;
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
      ]),
    };
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
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

    expect(response.answer).toBe("Grounded answer");
    expect(detector.detect).toHaveBeenCalledWith(expect.objectContaining({
      question: "tell me about yoga",
    }));
    expect(answerInputs).toHaveLength(1);
    expect(answerInputs[0]?.systemPrompt).toContain("Raja yoga");
    expect(answerInputs[0]?.systemPrompt).toMatch(/offer/i);
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual(["tell me about yoga", "tell me about yoga"]);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
    expect(saved).toMatchObject({
      source: "retrieval_sense",
      originalQuery: "tell me about yoga",
      mode: "offer",
      candidates: [
        expect.objectContaining({ id: "doc-hatha", payload: { documentIds: ["doc-hatha"] } }),
        expect.objectContaining({ id: "doc-raja", payload: { documentIds: ["doc-raja"] } }),
      ],
      status: "pending",
    });
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({
          surface: "retrieval_sense",
          decision: "offered",
          chosenCandidateId: "doc-hatha",
        }),
      }),
    ]));
  });

  it("forces an engine-prepared clarification question over directive-bound skill selection", async () => {
    let saved: PendingClarification | null = null;
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.59, payload: { documentIds: ["doc-raja"] } },
      ]),
    };
    const boundDirectiveRuntime: RouteScopedDirectiveRuntime = {
      matcher: {
        async match({ directives }) {
          return [{
            directive: directives[0]!,
            selectionMode: "deterministic" as const,
            selectionReason: "always",
          }];
        },
      },
      directivesFor: () => [{
        name: "force-retrieval",
        condition: { kind: "always" },
        action: "Force retrieval answer.",
        binding: { kind: "skill", skillName: "retrieval.answer" },
      }],
      async matchAndResolve(_input, directives) {
        return {
          rules: [],
          omissions: [],
          matches: [{
            directive: directives[0]!,
            selectionMode: "deterministic" as const,
            selectionReason: "always",
          }],
        };
      },
      async resolveMatches(_input, matches) {
        return { rules: [], omissions: [], matches };
      },
      async steer() {
        return { rules: [], omissions: [], matches: [] };
      },
    };
    const turnInterpreter: ChatServiceOptions["turnInterpreter"] = {
      interpretChatTurn: vi.fn(async () => ({
        route: "retrieval" as const,
        framing: { isIdentityQuestion: false },
      })),
    };
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
      detector,
      directiveRuntime: boundDirectiveRuntime,
      turnInterpreter,
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
    expect(answerInputs).toHaveLength(0);
    expect(turnInterpreter.interpretChatTurn).toHaveBeenCalledOnce();
    expect(capturedRequests.map((request) => request.query)).toEqual(["tell me about yoga", "tell me about yoga"]);
    expect(saved).toMatchObject({
      source: "retrieval_sense",
      originalQuery: "tell me about yoga",
      mode: "ask",
    });
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({
          surface: "retrieval_sense",
          decision: "asked",
        }),
      }),
    ]));
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "skill_selection",
        outputs: expect.objectContaining({
          selectedSkills: ["clarification.answer"],
        }),
      }),
    ]));
  });

  it("silently auto-picks the top retrieval sense when a would-offer candidate is missing an LLM label", async () => {
    let saved: PendingClarification | null = null;
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const detector = {
      detect: vi.fn(async () => [
        {
          id: "doc-hatha",
          label: "Whether the visitor means posture practice",
          labelStatus: "generated",
          confidence: 0.6,
          payload: { documentIds: ["doc-hatha"] },
        },
        {
          id: "doc-raja",
          label: "doc-raja",
          labelStatus: "missing",
          confidence: 0.58,
          payload: { documentIds: ["doc-raja"] },
        },
      ]),
    };
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
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

    expect(response.answer).toBe("Grounded answer");
    expect(saved).toBeNull();
    expect(answerInputs).toHaveLength(1);
    expect(answerInputs[0]?.systemPrompt).not.toContain("doc-raja");
    expect(answerInputs[0]?.systemPrompt).not.toContain("Raja Yoga Meditation");
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual(["tell me about yoga", "tell me about yoga"]);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({
          surface: "retrieval_sense",
          decision: "auto_picked",
          reason: "label_fallback",
          chosenCandidateId: "doc-hatha",
        }),
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
            { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
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
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual(["hatha", "hatha"]);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
  });

  it("uses the stored original question for the resolving retrieval run even when the router answers direct", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const originalQuery = "How do I upload a document via the REST API? Give me a curl example.";
    const service = makeService({
      capturedRequests,
      // The short sense answer routes direct; the resolved sense must still ground.
      route: "direct",
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          sessionId: "conv-1",
          source: "retrieval_sense",
          originalQuery,
          mode: "ask" as const,
          candidates: [
            { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
            { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
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

    const scopedRequests = capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha"));
    expect(scopedRequests).toHaveLength(2);
    expect(scopedRequests.map((request) => request.query)).toEqual([originalQuery, originalQuery]);
    expect(scopedRequests.some((request) => request.query === "the first one")).toBe(false);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-hatha"]);
    const clarificationStages = response.turnTrace?.spine.stages.filter((stage) => stage.kind === "clarification") ?? [];
    expect(JSON.stringify(clarificationStages)).not.toContain(originalQuery);
  });

  it("composes the non-streaming resolved retrieval_sense answer from the original question", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const routerInputs: TurnRouterInput[] = [];
    const directiveInputs: DirectiveSteerInput[] = [];
    const messageRepository = new InMemoryMessageRepository();
    const originalQuery = "How do I upload a document via the REST API? Give me a curl example.";
    const selectorReply = "the first one";
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
      directiveRuntime: captureDirectiveRuntime(directiveInputs),
      messageRepository,
      routerInputs,
      suggestedQuestionsEnabled: true,
      clarificationStore: {
        loadPending: vi.fn(async () => retrievalSensePending(originalQuery)),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: selectorReply,
      stream: false,
    });

    expect(routerInputs.map((routerInput) => routerInput.query)).toEqual([originalQuery]);
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual([originalQuery, originalQuery]);
    expect(answerInputs).toHaveLength(1);
    expect(answerInputs[0]?.query).toBe(originalQuery);
    expect(answerInputs[0]?.systemPrompt).toContain(originalQuery);
    expect(answerInputs[0]?.systemPrompt).not.toContain(selectorReply);
    expect(directiveInputs.length).toBeGreaterThan(0);
    expect(directiveInputs.map((input) => input.turnContext?.query)).not.toContain(selectorReply);
    expect(directiveInputs.map((input) => input.turnContext?.query)).toContain(originalQuery);
    const persistedUserMessages = [...messageRepository.items.values()].flat().filter((message) => message.role === "user");
    expect(persistedUserMessages.map((message) => message.content)).toEqual([selectorReply]);
  });

  it("matches directives against the original question for a resolved retrieval_sense turn on the engine path", async () => {
    const directiveInputs: DirectiveSteerInput[] = [];
    const originalQuery = "How do I upload a document via the REST API? Give me a curl example.";
    const selectorReply = "the first one";
    const service = makeService({
      directiveRuntime: captureDirectiveRuntime(directiveInputs),
      turnInterpreter: {
        interpretChatTurn: vi.fn(async () => ({
          route: "direct" as const,
          framing: { isIdentityQuestion: false },
        })),
      },
      clarificationStore: {
        loadPending: vi.fn(async () => retrievalSensePending(originalQuery)),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: selectorReply,
      stream: false,
    });

    expect(directiveInputs.length).toBeGreaterThan(0);
    expect(directiveInputs.map((input) => input.turnContext?.query)).toEqual(
      directiveInputs.map(() => originalQuery),
    );
  });

  it("accepts an offered alternative by answering the original question scoped to the alternative documents", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const originalQuery = "tell me about yoga";
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
      mapReply: vi.fn(async () => ({ kind: "chosen" as const, id: "doc-raja" })),
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          ...retrievalSensePending(originalQuery),
          mode: "offer" as const,
        })),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "raja",
      stream: false,
    });

    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-raja")).map((request) => request.query))
      .toEqual([originalQuery, originalQuery]);
    expect(answerInputs).toHaveLength(1);
    expect(answerInputs[0]?.query).toBe(originalQuery);
    expect(response.citations?.map((citation) => citation.documentId)).toEqual(["doc-raja"]);
  });

  it("answers a substantive follow-up that names an offered alternative as a normal new turn", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const answerInputs: ChatGatewayInput[] = [];
    const originalQuery = "tell me about yoga";
    const followUp = "what does Raja yoga cost?";
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ answerInputs }),
      mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          ...retrievalSensePending(originalQuery),
          mode: "offer" as const,
        })),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });

    await service.answer({
      workspaceId: "workspace-1",
      query: followUp,
      stream: false,
    });

    expect(capturedRequests.map((request) => request.query)).toEqual([followUp, followUp]);
    expect(capturedRequests.some((request) => request.documentScope?.includes("doc-raja"))).toBe(false);
    expect(answerInputs).toHaveLength(1);
    expect(answerInputs[0]?.query).toBe(followUp);
    expect(answerInputs[0]?.systemPrompt).not.toContain(originalQuery);
  });

  it("ignores an offer as a normal turn and loop-guards the same candidate set from being offered again", async () => {
    let saved: PendingClarification | null = null;
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
      ]),
    };
    const service = makeService({
      capturedRequests,
      detector,
      mapReply: vi.fn(async () => ({ kind: "unrelated" as const })),
      clarificationStore: {
        loadPending: vi.fn(async () => ({
          ...retrievalSensePending("tell me about yoga"),
          mode: "offer" as const,
        })),
        save: vi.fn(async (pending) => { saved = pending; }),
        clear: vi.fn(),
      },
    });

    const response = await service.answer({
      workspaceId: "workspace-1",
      query: "what does pricing include?",
      stream: false,
    });

    expect(response.answer).toBe("Grounded answer");
    expect(saved).toBeNull();
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual(["what does pricing include?", "what does pricing include?"]);
    expect(response.turnTrace?.spine.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "clarification",
        outputs: expect.objectContaining({
          surface: "retrieval_sense",
          decision: "auto_picked",
          reason: "loop_guard",
        }),
      }),
    ]));
  });

  it("composes the streaming resolved retrieval_sense answer from the original question", async () => {
    const capturedRequests: RetrievalPipelineRequest[] = [];
    const streamInputs: ChatGatewayInput[] = [];
    const routerInputs: TurnRouterInput[] = [];
    const messageRepository = new InMemoryMessageRepository();
    const originalQuery = "How do I upload a document via the REST API? Give me a curl example.";
    const selectorReply = "the first one";
    const service = makeService({
      capturedRequests,
      chatGateway: chatGateway({ streamInputs }),
      messageRepository,
      routerInputs,
      suggestedQuestionsEnabled: true,
      clarificationStore: {
        loadPending: vi.fn(async () => retrievalSensePending(originalQuery)),
        save: vi.fn(),
        clear: vi.fn(),
      },
    });
    const events = [];

    for await (const event of service.streamAnswer({
      workspaceId: "workspace-1",
      query: selectorReply,
      stream: true,
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(routerInputs.map((routerInput) => routerInput.query)).toEqual([originalQuery]);
    expect(capturedRequests.filter((request) => request.documentScope?.includes("doc-hatha")).map((request) => request.query))
      .toEqual([originalQuery, originalQuery]);
    expect(streamInputs).toHaveLength(1);
    expect(streamInputs[0]?.query).toBe(originalQuery);
    expect(streamInputs[0]?.systemPrompt).toContain(originalQuery);
    expect(streamInputs[0]?.systemPrompt).not.toContain(selectorReply);
    const persistedUserMessages = [...messageRepository.items.values()].flat().filter((message) => message.role === "user");
    expect(persistedUserMessages.map((message) => message.content)).toEqual([selectorReply]);
  });

  it("suppresses asking while an active routine has yielded and records a suppressed decision", async () => {
    const detector = {
      detect: vi.fn(async () => [
        { id: "doc-hatha", label: "Hatha yoga", confidence: 0.6, payload: { documentIds: ["doc-hatha"] } },
        { id: "doc-raja", label: "Raja yoga", confidence: 0.55, payload: { documentIds: ["doc-raja"] } },
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
