import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { RetrievalAnswerComposer } from "../../../src/modules/chat/services/retrievalTurnSkill.js";
import type { TurnStreamResult } from "../../../src/modules/chat/services/turnOutcome.js";
import { createDirectiveAdherenceSideChannel } from "../../../src/shared/domain/directiveAdherence.js";
import type { RetrievalPipelineResult } from "../../../src/modules/retrieval/public.js";

/**
 * The grounded answer's prompt and response schema on a turn that offers no reply blocks,
 * recorded from the composer before reply blocks existed. A turn that does not offer the
 * `present` head must send these byte for byte, so the provider's prompt and schema caches
 * stay warm and no live agent sees a change.
 */
const GOLDEN_PATH = fileURLToPath(new URL("../../fixtures/reply-blocks/grounded-answer-without-present.json", import.meta.url));

interface RecordedCall {
  systemPrompt: string;
  prompt: string;
  responseFormat: unknown;
}

interface GoldenCalls {
  answer: RecordedCall;
  stream: RecordedCall;
}

const ENVELOPE = JSON.stringify({
  coverage: "answered_sufficient_evidence",
  requestFocus: "hiking guides",
  outcome: "answer",
  answer: "We carry two hiking guides[[1]][[2]].",
  v: 2,
  claims: [[1], [2]],
  suggestions: [],
  grounding: "degraded",
});

const context = (index: number) => ({
  documentId: `doc-${index}`,
  chunkId: `chunk-${index}`,
  title: `Field Guide ${index}`,
  content: `Trail notes ${index}`,
  metadata: { sourceUrl: `https://shop.example/books/guide-${index}` },
});

const goldenSession = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", chatModelOverride: null } as never,
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "widget" } as never,
  history: [],
  userMessage: { id: "message-1", content: "Which hiking guides do you have?" } as never,
  effectiveQuery: "Which hiking guides do you have?",
  turnRoute: "retrieval",
  pageContext: null,
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  directiveSteering: { rules: [], matches: [], omissions: [] },
  retrieval: {
    systemPrompt: "system",
    prompt: "Result 1 (Field Guide 1): Trail notes 1\n\nResult 2 (Field Guide 2): Trail notes 2",
    responseIdentity: null,
    responseSettings: { suggestedQuestionsEnabled: true, suggestedQuestionsCount: 3 },
    diagnostics: {},
    contexts: [context(1), context(2)],
  } as unknown as RetrievalPipelineResult,
}) as unknown as PreparedSession;

const recordingGateway = (calls: Partial<GoldenCalls>): ChatGateway => {
  const record = (input: ChatGatewayInput): RecordedCall => ({
    systemPrompt: input.systemPrompt ?? "",
    prompt: input.prompt ?? "",
    responseFormat: input.generation?.responseFormat,
  });
  return {
    async answer(input) {
      calls.answer = record(input);
      return ENVELOPE;
    },
    async *streamAnswer(input) {
      calls.stream = record(input);
      yield ENVELOPE;
    },
  };
};

const fallback: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "decline", declineReason: "content_gap" };
  },
};

const presenter = () => new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, {
  supportsGroundedAnswer: () => true,
});

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>): Promise<TurnStreamResult> => {
  let step = await generator.next();
  while (!step.done) {
    step = await generator.next();
  }
  return step.value;
};

const recordCalls = async (composer: RetrievalAnswerComposer, calls: Partial<GoldenCalls>, session: () => PreparedSession) => {
  await composer.composeAnswer(session(), "Which hiking guides do you have?", "en", undefined);
  await drain(composer.streamAnswer(session(), "Which hiking guides do you have?", "en", undefined));
  return calls as GoldenCalls;
};

const composerWithoutReplyBlocks = (calls: Partial<GoldenCalls>) => new RetrievalAnswerComposer(
  new ChatAnswerSupport(),
  recordingGateway(calls),
  presenter(),
  fallback,
  null,
  { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules) },
);

describe("reply blocks capability gating", () => {
  it("sends the recorded prompt and schema on a turn without reply blocks", async () => {
    const recorded: Partial<GoldenCalls> = {};
    const calls = await recordCalls(composerWithoutReplyBlocks(recorded), recorded, goldenSession);
    if (process.env.RECORD_REPLY_BLOCKS_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(calls, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenCalls;
    expect(calls).toStrictEqual(golden);
    expect(JSON.stringify(calls)).toBe(JSON.stringify(golden));
  });
});
