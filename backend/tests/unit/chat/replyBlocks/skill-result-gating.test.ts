import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../../../src/modules/chat/contracts/chatGateway.js";
import type { ReplyBlocksCapability } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { AGENT_SKILL_OUTCOME_KIND } from "../../../../src/modules/chat/composition.js";
import { buildChatTurnRuntime } from "../../../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../../../src/modules/chat/services/chatSessionPreparer.js";
import { SkillResultReplyBlocks } from "../../../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import type { TurnOutcome, TurnStreamResult } from "../../../../src/modules/chat/services/turnOutcome.js";
import type { SkillOutcome } from "../../../../src/modules/skills/public.js";

/**
 * A skill-result reply's prompt and generation options on a turn that offers no `present` head,
 * recorded from the composer before skill results could become cards. A turn that does not offer
 * the head must send these byte for byte, so the provider's caches stay warm and no live agent
 * sees a change: a client that declares no reply blocks, and a skill that returned no records.
 */
const GOLDEN_PATH = fileURLToPath(new URL("../../../fixtures/reply-blocks/skill-result-without-present.json", import.meta.url));

interface RecordedCall {
  prompt: string;
  generation: unknown;
}

interface GoldenCalls {
  answer: RecordedCall;
  stream: RecordedCall;
}

const SKILL_TEXT = "Found two flats: Loft Mitte at 1,850 and Altbau Prenzlauer Berg at 1,990.";
const REPLY = "Two flats match: Loft Mitte and Altbau Prenzlauer Berg.";
const QUERY = "Flats in Mitte under 2,000?";

const LISTINGS = [
  { name: "Loft Mitte", rent: 1850, url: "https://homes.example/listings/loft-mitte" },
  { name: "Altbau Prenzlauer Berg", rent: 1990, url: "https://homes.example/listings/altbau-pb" },
];

const session = (replyBlocks: ReplyBlocksCapability | null): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Nico", chatModelOverride: null },
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "widget" },
  userMessage: { id: "message-1", content: QUERY },
  effectiveQuery: QUERY,
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: { customInstruction: "Help visitors find a flat." } },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: {
    rules: [{ action: "Search the listings and tell the visitor what matches.", source: "directive", lifespan: "response" }],
    omissions: [],
    matches: [],
  },
  replyBlocks,
} as unknown as PreparedSession);

const outcome = (over: Partial<SkillOutcome>): TurnOutcome => ({
  kind: AGENT_SKILL_OUTCOME_KIND,
  skillName: "search_listings",
  outcome: { status: "completed", answer: SKILL_TEXT, ...over },
  stagedContext: [],
  steering: [],
  trace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
});

const recordingGateway = (calls: Partial<GoldenCalls>): ChatGateway => {
  const record = (input: ChatGatewayInput): RecordedCall => ({ prompt: input.prompt, generation: input.generation ?? null });
  return {
    async answer(input) {
      calls.answer = record(input);
      return REPLY;
    },
    async *streamAnswer(input) {
      calls.stream = record(input);
      yield REPLY;
    },
  };
};

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>): Promise<TurnStreamResult> => {
  let step = await generator.next();
  while (!step.done) {
    step = await generator.next();
  }
  return step.value;
};

const recordCalls = async (turn: TurnOutcome, replyBlocks: ReplyBlocksCapability | null): Promise<GoldenCalls> => {
  const calls: Partial<GoldenCalls> = {};
  const runtime = buildChatTurnRuntime({
    chatGateway: recordingGateway(calls),
    fallbackReplyComposer: { composeNoContext: vi.fn() },
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    skillResultReplyBlocks: new SkillResultReplyBlocks({
      imageUrls: { forImage: (imageId) => ({ src: `https://api.example/${imageId}`, srcSet: "" }) },
    }),
  });
  const ctx = { session: session(replyBlocks), query: QUERY };
  await runtime.skillResultRenderer.render(turn, ctx);
  await drain(runtime.skillResultRenderer.stream!(turn, ctx));
  return calls as GoldenCalls;
};

const expectGolden = (calls: GoldenCalls) => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenCalls;
  expect(calls).toStrictEqual(golden);
  expect(JSON.stringify(calls)).toBe(JSON.stringify(golden));
};

describe("skill result reply gating", () => {
  it("sends the recorded prompt and options when the skill returned text alone", async () => {
    const calls = await recordCalls(outcome({}), null);
    if (process.env.RECORD_SKILL_RESULT_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(calls, null, 2)}\n`);
    }

    expectGolden(calls);
  });

  it("sends the recorded prompt and options when the client declares no reply blocks, whatever records the skill returned", async () => {
    expectGolden(await recordCalls(outcome({ outputs: { structuredContent: LISTINGS } }), null));
  });

  it("sends the recorded prompt and options when the client renders no item list", async () => {
    expectGolden(await recordCalls(outcome({ outputs: { structuredContent: LISTINGS } }), {}));
  });

  it("sends the recorded prompt and options when the skill returned no records", async () => {
    expectGolden(await recordCalls(outcome({}), { item_list: { layouts: ["carousel", "list"] } }));
  });
});
