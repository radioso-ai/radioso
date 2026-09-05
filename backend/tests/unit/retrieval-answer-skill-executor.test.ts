import { describe, expect, it, vi } from "vitest";

import {
  RETRIEVAL_ANSWER_ADAPTER,
  RetrievalAnswerSkillExecutor,
  readRetrievalResult,
} from "../../src/modules/retrieval/public.js";
import type {
  RetrievalPipelineInterpretationResult,
  RetrievalPipelinePort,
  RetrievalPipelineResult,
} from "../../src/modules/retrieval/services/retrievalPipelineService.js";
import { noopSkillEmitPort, type SkillDefinition } from "../../src/modules/skills/public.js";

const sampleResult = (): RetrievalPipelineResult =>
  ({
    rewrittenQuery: "rewritten",
    contexts: [{
      documentId: "doc_1",
      chunkId: "chunk_1",
      title: "Course Guide",
      content: "Kriya is introduced in the first module.",
      metadata: { sourceUrl: "https://example.com/guide" },
      retrievalSources: ["semantic_original"],
      retrievalText: "Kriya is introduced in the first module.",
      semanticScore: 0.9,
      lexicalScore: 0,
      similarity: 0.9,
      relevanceScore: 0.91,
      rerankPosition: 0,
      promptPosition: 0,
      estimatedTokenCost: 12,
    }],
    systemPrompt: "system",
    prompt: "prompt",
    citations: [{ documentId: "doc_1", chunkId: "chunk_1", title: "Course Guide" }],
    responseIdentity: null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 3,
    },
    diagnostics: {} as RetrievalPipelineResult["diagnostics"],
    trace: { traceId: "t", startedAt: "now", stages: [], links: [] },
  });

const stubController = (result: RetrievalPipelineResult): RetrievalPipelinePort => ({
  run: vi.fn().mockResolvedValue(result),
  interpret: vi.fn(),
  runInterpreted: vi.fn().mockResolvedValue(result),
  runWithoutRetrieval: vi.fn().mockResolvedValue(result),
});

const request = { workspaceId: "w1", query: "hello", history: [] };

const invocation = (context: Record<string, unknown>, collected: Record<string, unknown> = {}) => ({
  skill: { name: "retrieval.answer" } as SkillDefinition,
  collected,
  context,
  emit: noopSkillEmitPort,
});

const contextInvocation = (context: Record<string, unknown>, collected: Record<string, unknown> = {}) => ({
  skill: { name: "retrieval.context" } as SkillDefinition,
  collected,
  context,
  emit: noopSkillEmitPort,
});

describe("RetrievalAnswerSkillExecutor", () => {
  it("declares the retrieval_answer internal adapter key", () => {
    expect(RETRIEVAL_ANSWER_ADAPTER).toBe("retrieval_answer");
  });

  it("runs the controller and settles with the rich result on the non-model channel", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch(invocation({ request }));

    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("completed");
    // The rich pipeline result rides on metadata (not model-visible outputs).
    expect(readRetrievalResult(dispatch.outcome)).toBe(result);
    expect(dispatch.outcome.outputs).toBeUndefined();
    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", query: "hello" }));
  });

  it("settles retrieval.context with safe grounding outputs instead of a ready answer", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch(contextInvocation({ request }));

    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("context_ready");
    expect(dispatch.outcome.answer).toBeUndefined();
    expect(dispatch.outcome.outputs).toMatchObject({
      has_context: true,
      source_count: 1,
      contexts: [{
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        content: "Kriya is introduced in the first module.",
      }],
      citations: [{ documentId: "doc_1", chunkId: "chunk_1", title: "Course Guide" }],
    });
    expect(readRetrievalResult(dispatch.outcome)).toBe(result);
  });

  it("settles retrieval.context with no_context when no chunks were retrieved", async () => {
    const result = { ...sampleResult(), contexts: [], citations: [] };
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch(contextInvocation({ request }));

    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("no_context");
    expect(dispatch.outcome.outputs).toMatchObject({
      has_context: false,
      source_count: 0,
      contexts: [],
      citations: [],
    });
  });

  it("runs a named retrieve skill with its configured source scope and instruction", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch({
      skill: {
        name: "retrieve_events",
        metadata: {
          retrieveConfig: {
            sourceScope: { sourceIds: ["2e0c6264-f2c4-4549-bcd8-bf2f7d1a0d1e"] },
            instruction: "Use event documents only.",
            vectorTopK: 7,
            exposedInputs: { query: true },
          },
        },
      },
      collected: { query: "Which events are upcoming?" },
      context: {
        workspaceId: "w1",
        turn: {
          sessionId: "conversation-1",
          inputEvent: { id: "message-2", kind: "message", content: "continue", locale: "en" },
          agent: { id: "agent-1", metadata: {} },
          history: [],
          stagedContext: [],
          steering: [],
        },
      },
      emit: noopSkillEmitPort,
    });

    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({
      query: "Which events are upcoming?",
      sourceScope: { mode: "selected", sourceIds: ["2e0c6264-f2c4-4549-bcd8-bf2f7d1a0d1e"] },
      agentSkillSettings: {
        "retrieval.answer": {
          customInstruction: "Use event documents only.",
          vectorTopK: 7,
        },
      },
    }));
    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("found");
    expect(dispatch.outcome.outputs).toMatchObject({ found: true, source_count: 1 });
  });

  it("settles a named retrieve skill as empty when no contexts are found", async () => {
    const controller = stubController({ ...sampleResult(), contexts: [], citations: [] });
    const executor = new RetrievalAnswerSkillExecutor(controller);

    const dispatch = await executor.dispatch({
      skill: {
        name: "retrieve_events",
        metadata: { retrieveConfig: { sourceScope: "all", exposedInputs: { query: true } } },
      },
      collected: { query: "Anything?" },
      context: { request: { workspaceId: "w1", query: "Anything?", history: [] } },
      emit: noopSkillEmitPort,
    });

    expect(dispatch.disposition).toBe("settled");
    if (dispatch.disposition !== "settled") return;
    expect(dispatch.outcome.status).toBe("empty");
    expect(dispatch.outcome.outputs).toMatchObject({ found: false, source_count: 0 });
  });

  it("dispatches an interpreted result through runInterpreted when provided", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);
    const interpreted = { request } as unknown as RetrievalPipelineInterpretationResult;

    await executor.dispatch(invocation({ interpreted, withRetrieval: true }));
    expect(controller.runInterpreted).toHaveBeenCalledWith(interpreted);
    expect(controller.run).not.toHaveBeenCalled();
  });

  it("uses a bound query from collected instead of the turn's latest message", async () => {
    const controller = stubController(sampleResult());
    const executor = new RetrievalAnswerSkillExecutor(controller);

    await executor.dispatch(invocation({
      workspaceId: "w1",
      turn: {
        sessionId: "conversation-1",
        inputEvent: { id: "message-2", kind: "message", content: "the user's latest unrelated reply", locale: "en" },
        agent: { id: "agent-1", metadata: {} },
        history: [],
        stagedContext: [],
        steering: [],
      },
    }, { query: "the bound question" }));

    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({ query: "the bound question" }));
  });

  it("builds a retrieval request from a routine turn context", async () => {
    const result = sampleResult();
    const controller = stubController(result);
    const executor = new RetrievalAnswerSkillExecutor(controller);

    await executor.dispatch(invocation({
      workspaceId: "w1",
      turn: {
        sessionId: "conversation-1",
        inputEvent: { id: "message-2", kind: "message", content: "What is Kriya?", locale: "en" },
        agent: {
          id: "agent-1",
          metadata: {
            skillSettings: {
              "retrieval.answer": { vectorTopK: 4 },
            },
          },
        },
        history: [{
          id: "message-1",
          role: "user",
          content: "Earlier question",
          createdAt: "2026-06-17T08:00:00.000Z",
          metadata: { source: "test" },
        }],
        stagedContext: [],
        steering: [],
      },
    }));

    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "w1",
      query: "What is Kriya?",
      responseLanguage: "en",
      agentSkillSettings: {
        "retrieval.answer": { vectorTopK: 4 },
      },
    }));
    expect(controller.run).toHaveBeenCalledWith(expect.objectContaining({
      history: [expect.objectContaining({
        id: "message-1",
        conversationId: "conversation-1",
        workspaceId: "w1",
        role: "user",
        content: "Earlier question",
      })],
    }));
  });

  it("uses runWithoutRetrieval for an interpreted, non-retrieval turn", async () => {
    const controller = stubController(sampleResult());
    const executor = new RetrievalAnswerSkillExecutor(controller);
    const interpreted = { request } as unknown as RetrievalPipelineInterpretationResult;

    await executor.dispatch(invocation({ interpreted, withRetrieval: false }));
    expect(controller.runWithoutRetrieval).toHaveBeenCalledWith(interpreted);
    expect(controller.runInterpreted).not.toHaveBeenCalled();
  });

  it("rejects an invocation that carries neither a request nor an interpreted result", async () => {
    const executor = new RetrievalAnswerSkillExecutor(stubController(sampleResult()));
    await expect(executor.dispatch(invocation({}))).rejects.toThrow(/request|interpreted/i);
  });
});
