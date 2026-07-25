import { describe, expect, it, vi } from "vitest";

import { renderContextBlock } from "../../src/modules/context-variables/contextBlockRenderer.js";
import { resolveContextForTurn, type ResolvedVariableInput } from "../../src/modules/context-variables/public.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import { buildAssistantReplyPrompt } from "../../src/modules/chat/services/assistantReplyPromptBuilder.js";
import { ChatSessionPreparer } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalTurnPort } from "../../src/modules/chat/services/retrievalTurnDispatch.js";
import {
  freezePageReadOutcome,
} from "../../src/modules/chat/services/pageRead/pageReadSessionOutcome.js";
import type {
  PageReadCapability,
  PageReadDecision,
} from "../../src/modules/chat/services/pageRead/pageReadDecision.js";
import type { RetrievalPipelineRequest, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import {
  createAuditService,
  InMemoryAgentRepository,
  InMemoryConversationRepository,
  InMemoryMessageRepository,
} from "../support/fakes.js";

const pageContext = {
  pageUrl: "https://example.test/private-page",
  pageTitle: "Private page",
  pageLocale: "en",
  browserLocale: "en-US",
  content: "PAGE_BYTES_MUST_BE_GATED",
};

const hostVariables: ResolvedVariableInput[] = [
  {
    name: "cart",
    description: "the visitor cart",
    value: { items: 2 },
    surfacing: "always",
    trust: "verified",
  },
  {
    name: "plan",
    value: "pro",
    surfacing: "on_reference",
  },
];

const contentCapability: PageReadCapability = {
  available: true,
  mode: "content",
  supportedOperations: ["metadata", "lookup", "summarize"],
};

const fixedRetrievalResult = (request: RetrievalPipelineRequest): RetrievalPipelineResult => {
  const now = new Date().toISOString();
  return {
    rewrittenQuery: request.query,
    contexts: [],
    systemPrompt: "",
    prompt: "RETRIEVAL_PROMPT",
    citations: [],
    responseIdentity: request.responseIdentity ?? null,
    responseSettings: {
      citationDisplayEnabled: true,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 0,
      customInstruction: request.responseBehavior?.customInstruction,
      responseLanguagePolicy: "match_user_question",
      responseLanguage: request.responseLanguage,
    },
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
      parsedQuery: {
        semanticQuery: request.query,
        lexicalQuery: request.query,
        constraints: [],
      },
    },
    trace: {
      traceId: "page-read-sink-gate",
      startedAt: now,
      completedAt: now,
      totalDurationMs: 0,
      stages: [],
      links: [],
    },
  };
};

const harness = async (capability: PageReadCapability = contentCapability) => {
  const agentRepository = new InMemoryAgentRepository();
  const agent = await agentRepository.create("ws-1", { name: "Page Bot" });
  const retrievalTurn: RetrievalTurnPort = {
    async interpret(request) {
      return {
        request,
        traceStartedAtMs: Date.now(),
        context: { result: {} as never, startedAt: Date.now(), durationMs: 0 },
        interpretation: { result: {}, startedAt: Date.now(), durationMs: 0 },
      };
    },
    async dispatch(input) {
      return fixedRetrievalResult(input.interpreted.request);
    },
  };
  const resolveForAgent = vi.fn(async () => hostVariables);
  const preparer = new ChatSessionPreparer(
    new InMemoryConversationRepository(),
    new InMemoryMessageRepository(),
    retrievalTurn,
    createAuditService(),
    undefined,
    { resolve: async () => agent },
    undefined,
    { resolveForAgent },
  );
  const input = {
    workspaceId: "ws-1",
    agentId: agent.id,
    query: "What does this page say?",
    pageContext,
    pageReadCapability: capability,
  };
  const session = await preparer.prepare(input, { skipRetrieval: true });
  return { input, preparer, session };
};

const freezePlannerDecision = (
  session: Awaited<ReturnType<typeof harness>>["session"],
  planner: PageReadDecision,
) =>
  freezePageReadOutcome(session, {
    planner,
    routineCandidates: [],
    directiveCandidates: [],
    fallbackRequest: session.effectiveQuery,
  });

describe("page-read three-sink gate", () => {
  it("keeps a not-required page out of all three sinks without changing host variables", async () => {
    const { input, preparer, session } = await harness();
    freezePlannerDecision(session, { required: false, operation: null, resolvedRequest: null });

    const prepared = await preparer.prepareDirect(input, session);
    const expectedHostContext = resolveContextForTurn(null, hostVariables);
    const support = new ChatAnswerSupport();

    expect(support.buildContextBlock(prepared)).toBe(renderContextBlock(expectedHostContext.renderFragments));
    expect(support.buildContextBlock(prepared)).not.toContain(pageContext.content);
    expect(prepared.stagedContext.filter((entry) => entry.kind === "context_variable"))
      .toEqual(expectedHostContext.staged);
    expect(prepared.resolvedContext).toEqual(expectedHostContext);
    expect(prepared.resolvedContext.snapshot).not.toHaveProperty("page_context");
  });

  it("preserves today's exact page shapes in all three sinks on capture", async () => {
    const { input, preparer, session } = await harness();
    freezePlannerDecision(session, {
      required: true,
      operation: "lookup",
      resolvedRequest: "What does this page say?",
    });

    const prepared = await preparer.prepareDirect(input, session);
    const expectedContext = resolveContextForTurn(pageContext, hostVariables);
    const support = new ChatAnswerSupport();

    expect(support.buildContextBlock(prepared)).toBe(renderContextBlock(expectedContext.renderFragments));
    expect(prepared.stagedContext.filter((entry) => entry.kind === "context_variable"))
      .toEqual(expectedContext.staged);
    expect(prepared.resolvedContext).toEqual(expectedContext);
  });

  it.each([
    {
      name: "unavailable",
      capability: {
        available: false,
        mode: null,
        supportedOperations: [],
      } satisfies PageReadCapability,
      decision: {
        required: true,
        operation: "lookup",
        resolvedRequest: "Find the return window",
      } satisfies PageReadDecision,
      condition: "page_context_unavailable",
    },
    {
      name: "unsupported operation",
      capability: contentCapability,
      decision: {
        required: true,
        operation: "transform",
        resolvedRequest: "Translate this page",
      } satisfies PageReadDecision,
      condition: "page_operation_unsupported",
    },
  ])("keeps page bytes out and gives answer composition the typed $name condition", async ({
    capability,
    condition,
    decision,
  }) => {
    const { input, preparer, session } = await harness(capability);
    freezePlannerDecision(session, decision);

    const prepared = await preparer.prepareDirect(input, session);
    const support = new ChatAnswerSupport();
    const retrievalPrompt = support.buildPromptWithContext("BASE_PROMPT", prepared);
    const directPrompt = buildAssistantReplyPrompt({
      route: "direct",
      answerInstructionBlock: "",
      history: [],
      query: input.query,
      pageContextBlock: support.buildContextBlock(prepared),
      pageContextCondition: support.pageContextCondition(prepared),
    });

    expect(prepared.stagedContext.some((entry) => entry.id === "page_context")).toBe(false);
    expect(prepared.resolvedContext.fragments.some((fragment) => fragment.kind === "page_context")).toBe(false);
    expect(prepared.resolvedContext.snapshot).not.toHaveProperty("page_context");
    expect(retrievalPrompt).toContain(condition);
    expect(directPrompt).toContain(condition);
    expect(retrievalPrompt).not.toContain(pageContext.pageUrl);
    expect(retrievalPrompt).not.toContain(pageContext.content);
    expect(directPrompt).not.toContain(pageContext.pageUrl);
    expect(directPrompt).not.toContain(pageContext.content);
  });

  it("freezes the merged decision and gate once so downstream reads cannot recompute it", async () => {
    const { session } = await harness();
    const first = freezePlannerDecision(session, {
      required: true,
      operation: "lookup",
      resolvedRequest: "first request",
    });
    const second = freezePlannerDecision(session, {
      required: true,
      operation: "transform",
      resolvedRequest: "second request",
    });

    expect(second).toBe(first);
    expect(session.pageReadOutcome).toBe(first);
    expect(first).toMatchObject({
      merged: {
        decision: {
          required: true,
          operation: "lookup",
          resolvedRequest: "first request",
        },
      },
      gate: {
        kind: "capture",
        operation: "lookup",
        resolvedRequest: "first request",
      },
    });
  });
});
