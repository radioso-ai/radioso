import { describe, expect, it, vi } from "vitest";

import { AGENT_SKILL_OUTCOME_KIND } from "../../../src/modules/chat/composition.js";
import type { ChatGatewayInput } from "../../../src/modules/chat/contracts/chatGateway.js";
import { buildChatTurnRuntime } from "../../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import { SkillResultReplyBlocks } from "../../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import {
  evaluateTraceAssertion,
  scoreObservedOutput,
  type ConversationQualityCase,
  type ConversationQualityObservedOutput,
} from "../../../src/modules/eval/suite/index.js";
import { conversationQualityCases } from "../../fixtures/conversation-quality/index.js";
import { TOOL_CARD_SKILL_NAME, toolCardStubTool } from "../../fixtures/conversation-quality/toolCardCases.js";

const caseById = (id: string): ConversationQualityCase => conversationQualityCases.find((evalCase) => evalCase.id === id)!;

/**
 * Runs a tool-card case the way the live run does, with the model scripted: the stub search's
 * result for the case's message becomes the bound skill's outcome, and the skill-result reply is
 * written from it with the case's declared capability.
 */
/** The model's reply: the envelope to a request offered cards, and `plain` to one written without them. */
const scripted = (envelope: unknown, plain = "Several flats fit your budget.") => (input: ChatGatewayInput): string =>
  input.generation?.responseFormat ? JSON.stringify(envelope) : plain;

const runCase = async (
  evalCase: ConversationQualityCase,
  envelope: unknown,
  calls: ChatGatewayInput[] = [],
): Promise<ConversationQualityObservedOutput> => {
  const query = evalCase.query ?? "";
  const result = toolCardStubTool.respond({ message: query });
  const reply = typeof envelope === "function" ? (envelope as (input: ChatGatewayInput) => string) : scripted(envelope);
  let next = 0;
  const runtime = buildChatTurnRuntime({
    chatGateway: {
      answer: vi.fn(async (input: ChatGatewayInput) => {
        calls.push(input);
        return reply(input);
      }),
      async *streamAnswer(input: ChatGatewayInput) {
        calls.push(input);
        yield reply(input);
      },
    },
    fallbackReplyComposer: { composeNoContext: vi.fn(async () => ({ text: "I could not find that.", declineReason: "content_gap" as const })) },
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    skillResultReplyBlocks: new SkillResultReplyBlocks({
      imageUrls: { forImage: (imageId) => ({ src: `https://api.example/api/v1/public/reply-images/${imageId}/640`, srcSet: "" }) },
      newImageId: () => `image-${++next}`,
    }),
  });
  const session = {
    agent: { id: "agent-1", workspaceId: "cq-workspace", name: "Homes", chatModelOverride: null },
    conversation: { id: "cq-replay", workspaceId: "cq-workspace", sourceChannel: "authenticated_chat" },
    userMessage: { id: "message-1", content: query },
    effectiveQuery: query,
    history: [],
    turnRoute: "retrieval",
    retrieval: { responseIdentity: null, responseSettings: {} },
    resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
    directiveSteering: { rules: [], omissions: [], matches: [] },
    replyBlocks: evalCase.clientContextCapabilities?.["reply.blocks"],
  } as unknown as PreparedSession;
  const presentation = await runtime.skillResultRenderer.render({
    kind: AGENT_SKILL_OUTCOME_KIND,
    skillName: TOOL_CARD_SKILL_NAME,
    outcome: { status: "completed", answer: result.content[0]?.text, outputs: result.structuredContent },
    stagedContext: [],
    steering: [],
    trace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
  }, { session, query });
  return {
    retrievedChunks: [],
    answer: presentation.answer,
    ...(presentation.replyBlocks ? { replyBlocks: presentation.replyBlocks.presented } : {}),
  };
};

const statuses = async (evalCase: ConversationQualityCase, envelope: unknown) =>
  (await scoreObservedOutput(evalCase.assertions, await runCase(evalCase, envelope), { workspaceId: "cq-workspace", question: evalCase.query ?? "", runId: "run-1" }))
    .verdicts.map((verdict) => verdict.status);

const fields = { title: "/name", subtitle: "/area", image: "/photos/0/url", link: "/url" };

describe("tool-card cases on the deterministic harness", () => {
  it("passes the listings case when the model shows the listings within budget, and fails it when it shows none", async () => {
    const listings = caseById("tool-cards-listings-carousel");

    expect(await statuses(listings, { present: { records: ["r1", "r2", "r3", "r4"], fields, caption: "Flats in Mitte" }, answer: "Four flats in Mitte fit your budget." }))
      .toEqual(["pass", "pass", "pass"]);
    expect(await statuses(listings, { present: { records: [], fields, caption: "Flats" }, answer: "Four flats fit." }))
      .toEqual(["fail", "pass", "pass"]);
  });

  it("fails the listings case on a card for a listing over the budget", async () => {
    const listings = caseById("tool-cards-listings-carousel");

    expect(await statuses(listings, { present: { records: ["r1", "r5"], fields, caption: "Flats in Mitte" }, answer: "Two flats." }))
      .toEqual(["fail", "pass", "pass"]);
  });

  it("fails the listings case on an answer that names a record by its handle", async () => {
    const listings = caseById("tool-cards-listings-carousel");

    expect(await statuses(listings, { present: { records: ["r1", "r2"], fields, caption: "Flats in Mitte" }, answer: "See [r1] and [r2]." }))
      .toEqual(["pass", "fail", "pass"]);
  });

  it("answers again without cards when the model points the title at something that is not text", async () => {
    const listings = caseById("tool-cards-listings-carousel");
    const calls: ChatGatewayInput[] = [];
    const wrongTitle = { present: { records: ["r1", "r2"], fields: { ...fields, title: "/photos" }, caption: "Flats" }, answer: "Here are the flats below." };

    const output = await runCase(listings, scripted(wrongTitle, "The loft on Torstrasse and the Altbau flat fit your budget."), calls);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.generation).toBeUndefined();
    expect(output.answer).toBe("The loft on Torstrasse and the Altbau flat fit your budget.");
    expect(output.replyBlocks).toBeUndefined();
    const scored = await scoreObservedOutput(
      [{ type: "no_reply_block" }, { type: "answer_excludes_image_url" }],
      output,
      { workspaceId: "cq-workspace", question: listings.query ?? "", runId: "run-1" },
    );
    expect(scored.verdicts.map((verdict) => verdict.status)).toEqual(["pass", "pass"]);
  });

  it("fails the listings case on a card whose link is not its own record's", async () => {
    const listings = caseById("tool-cards-listings-carousel");
    const mixed = { ...fields, link: "/photos/1/url" };

    expect(await statuses(listings, { present: { records: ["r1", "r2"], fields: mixed, caption: "Flats" }, answer: "Two flats fit." }))
      .toEqual(["fail", "pass", "pass"]);
  });

  it("passes the offices case on a list or no cards, and fails it when a page address is shown as a picture", async () => {
    const offices = caseById("tool-cards-records-without-pictures");
    const officeFields = { title: "/name", subtitle: "/address", image: null, link: "/url" };

    expect(await statuses(offices, { present: { records: ["r1", "r2", "r3"], fields: officeFields, caption: "Our offices" }, answer: "We have three offices." }))
      .toEqual(["pass", "pass", "pass"]);
    expect(await statuses(offices, { present: { records: [], fields: officeFields, caption: "Offices" }, answer: "We have three offices." }))
      .toEqual(["pass", "pass", "pass"]);
    expect(await statuses(offices, { present: { records: ["r1"], fields: { ...officeFields, image: "/url" }, caption: "Offices" }, answer: "Our Mitte office." }))
      .toEqual(["fail", "pass", "pass"]);
  });

  it("passes the no-match case when the model shows no flat for a houseboat, and fails it when it shows flats", async () => {
    const noMatch = caseById("tool-cards-no-match-no-cards");

    expect(await statuses(noMatch, { present: { records: [], fields, caption: "Houseboats" }, answer: "We have no houseboats, only flats." }))
      .toEqual(["pass", "pass", "pass"]);
    expect(await statuses(noMatch, { present: { records: ["r1"], fields, caption: "Flats" }, answer: "No houseboats, but this flat." }))
      .toEqual(["fail", "pass", "pass"]);
  });
});

describe("tool-card assertions", () => {
  const item = (title: string, url?: string, image = false) => ({
    key: title,
    title,
    ...(image ? { image: { src: "https://api.example/i/640", width: 640, height: 480, alt: title } } : {}),
    actions: url ? [{ type: "open" as const, url }] : [],
  });
  const output = (items: ReturnType<typeof item>[]): ConversationQualityObservedOutput => ({
    retrievedChunks: [],
    replyBlocks: [{ type: "item_list", id: "b1", layout: "list", selection: "none", caption: "x", items }],
  });

  it("judges itemsFromRecords by each item's title and its own record's link", () => {
    const records = [{ title: "Loft", link: "https://homes.example/listings/loft" }, { title: "Studio" }];

    expect(evaluateTraceAssertion({ type: "reply_block", itemsFromRecords: records }, output([item("Loft", "https://homes.example/listings/loft"), item("Studio")])).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "reply_block", itemsFromRecords: records }, output([item("Garden flat")])).status).toBe("fail");
    expect(evaluateTraceAssertion({ type: "reply_block", itemsFromRecords: records }, output([item("Studio", "https://homes.example/listings/loft")])).status).toBe("fail");
  });

  it("judges reply_block_without_pictures on no block, a block without pictures, and one with a picture", () => {
    expect(evaluateTraceAssertion({ type: "reply_block_without_pictures" }, { retrievedChunks: [] }).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "reply_block_without_pictures" }, output([item("Mitte office")])).status).toBe("pass");
    expect(evaluateTraceAssertion({ type: "reply_block_without_pictures" }, output([item("Mitte office", undefined, true)])).status).toBe("fail");
  });
});
