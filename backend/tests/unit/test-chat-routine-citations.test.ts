import { describe, expect, it, vi } from "vitest";

import type { Routine } from "@radioso/conversation-contract";
import { DefaultConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";
import { RoutineStepRenderer } from "@radioso/conversation-defaults";

import type { AgentRevision } from "../../src/modules/agents/agentRevision.js";
import type { ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import type { ChatRoutineProvider } from "../../src/modules/chat/contracts/routineProvider.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { TrustedTestExecutionRunnerAdapter } from "../../src/modules/chat/services/trustedTestExecutionRunnerAdapter.js";
import { WorkbenchReplayRunner } from "../../src/modules/chat/services/workbenchReplayRunner.js";
import { RetrievalAnswerSkillExecutor, type RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import { RoutineSkillExecutorDispatcher, StaticRoutineSkillResolver } from "../../src/modules/routines/skillDispatcher.js";
import { retrievalContextSkillDefinition, SkillExecutorRegistry } from "../../src/modules/skills/public.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";
import { conversationQualityAgentConfig } from "../fixtures/conversation-quality/agent.js";
import { createAuditService } from "../support/fakes.js";

// #1816: a routine step that answers from the workspace's documents. In the public chat its reply
// shows "Sources N"; Test Chat must carry the same sources for the same turn.

const revision: AgentRevision = {
  id: "55555555-5555-4555-8555-555555555555",
  snapshot: { customInstruction: "", directives: [], routines: [], contextVariableEnablements: [] },
  sourceDraftGeneration: 1,
  sourceBasePublishedRevisionId: null,
  createdAt: new Date(0),
  publishedAt: null,
  publishedVersion: null,
};

const hoursRoutine: Routine = {
  id: "studio_hours",
  rootStepId: "lookup",
  steps: [
    { id: "lookup", kind: "skill", skillName: retrievalContextSkillDefinition.name },
    { id: "answer", kind: "chat", action: "Tell the visitor when the studio is open, from what the lookup found." },
  ],
  transitions: [{ from: "lookup", to: "answer", condition: "always" }],
};

const hoursRetrieval = {
  rewrittenQuery: "opening hours",
  contexts: [{
    documentId: "doc-hours",
    chunkId: "chunk-hours",
    title: "Opening hours",
    content: "The studio is open nine to five on weekdays.",
    metadata: { sourceUrl: "https://studio.example/hours" },
  }],
  systemPrompt: "retrieval system prompt",
  prompt: "Result 1 (Opening hours): The studio is open nine to five on weekdays.",
  citations: [],
  diagnostics: {},
  trace: { traceId: "retrieval-trace", startedAt: "2026-11-18T00:00:00.000Z", stages: [], links: [] },
} as unknown as RetrievalPipelineResult;

/** The step's reply as the model writes it, citing the one excerpt the lookup staged. */
const CITED_REPLY = "The studio is open nine to five on weekdays[[1]].";

/** A routine over the production routine stack: its lookup runs the real retrieval.context executor. */
const routineProvider = (): ChatRoutineProvider => {
  const registry = new SkillExecutorRegistry();
  registry.register({
    ...(retrievalContextSkillDefinition.execution as { kind: "internal"; adapter: string }),
    executor: new RetrievalAnswerSkillExecutor({ run: vi.fn(async () => hoursRetrieval) } as never),
  });
  return {
    forTurn: async ({ modelGateway }) => ({
      routines: [hoursRoutine],
      activator: { activate: async () => ({ kind: "activate" as const, routineId: hoursRoutine.id }) },
      runner: new DefaultRoutineRunner(
        [hoursRoutine],
        { select: async () => ({ nextStepId: "answer" }) },
        new RoutineStepRenderer(modelGateway),
        new RoutineSkillExecutorDispatcher(new StaticRoutineSkillResolver([retrievalContextSkillDefinition]), registry, { workspaceId: "ws-1" }),
      ),
    }),
  };
};

const noSuggestions = { apply: () => ({ suggestions: [] as ChatSuggestion[] }) } as unknown as AssistantSuggestionExpansionService;

/** Test Chat's runner over a routine turn, its replies presented by the presenter live chat uses. */
const testChatRunner = (streamed: boolean) => {
  const chatGateway = {
    answer: vi.fn(async (_input: ChatGatewayInput) => CITED_REPLY),
    ...(streamed ? { streamAnswer: async function* () { yield CITED_REPLY; } } : {}),
  };
  const replay = new WorkbenchReplayRunner({
    retrievalTurn: {
      interpret: async () => { throw new Error("a routine turn runs no chat retrieval"); },
      dispatch: async () => { throw new Error("a routine turn runs no chat retrieval"); },
    },
    auditService: createAuditService(),
    turnSkills: [],
    conversationEngine: new DefaultConversationEngine(),
    turnRouter: { classify: async () => ({ route: "direct", framing: { isIdentityQuestion: false } }) } as never,
    routineProvider: routineProvider(),
    chatGateway,
    chatAnswerPresenter: new ChatAnswerPresenter(noSuggestions),
  });
  return new TrustedTestExecutionRunnerAdapter({
    replay,
    liveAgentConfig: { find: async () => ({ ...conversationQualityAgentConfig, assistantDefaultLocale: "en" }) },
    revisions: { findRevision: async () => revision },
  });
};

const sendOnce = async (streamed: boolean) => {
  const turn = testChatRunner(streamed).stream({
    workspaceId: "ws-1",
    agentId: "agent-1",
    candidateRevision: revision,
    conversationId: "test-chat-side-1",
    message: "When is the studio open?",
    history: [],
    continuation: null,
    testValues: [],
    executionMode: "safe_test",
    skillEffects: "suppressed",
    accountId: "account-1",
  });
  let step = await turn.next();
  while (!step.done) step = await turn.next();
  return step.value;
};

describe("Test Chat routine reply sources (#1816)", () => {
  it.each([false, true])("keeps the sources live chat attaches to a routine step's grounded reply (streamed: %s)", async (streamed) => {
    // What live chat attaches to this reply: its presenter's reading of the step's cited excerpt.
    const live = new ChatAnswerPresenter(noSuggestions).presentRoutineAnswer(CITED_REPLY, [hoursRetrieval.contexts[0]]);
    expect(live.citations).toEqual([
      { documentId: "doc-hours", chunkId: "chunk-hours", title: "Opening hours", sourceUrl: "https://studio.example/hours" },
    ]);

    const result = await sendOnce(streamed);

    expect(result.answer).toBe(live.answer);
    expect(result.citations).toEqual(live.citations);
    expect(result.answerSegments).toEqual(live.answerSegments);
  });
});
