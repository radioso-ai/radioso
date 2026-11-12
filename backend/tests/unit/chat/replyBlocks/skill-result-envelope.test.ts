import { describe, expect, it, vi } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../../../src/modules/chat/contracts/chatGateway.js";
import type { ReplyBlocksCapability } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { AGENT_SKILL_OUTCOME_KIND } from "../../../../src/modules/chat/composition.js";
import { buildChatTurnRuntime } from "../../../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../../../src/modules/chat/services/chatSessionPreparer.js";
import { readPresentReplyEnvelope } from "../../../../src/modules/chat/services/replyBlocks/presentReplyEnvelope.js";
import { SkillResultReplyBlocks } from "../../../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import type { TurnOutcome, TurnStreamResult } from "../../../../src/modules/chat/services/turnOutcome.js";
import type { SkillOutcome } from "../../../../src/modules/skills/public.js";

const QUERY = "Flats in Mitte under 2,000?";
const LISTINGS = [
  { name: "Loft Mitte", rent: 1850, url: "https://homes.example/listings/loft-mitte", photo: "https://img.homes.example/loft.jpg" },
  { name: "Altbau Mitte", rent: 1990, url: "https://homes.example/listings/altbau-mitte", photo: "https://img.homes.example/altbau.jpg" },
];
const LEAD = "Two flats in Mitte fit your budget.";
const PRESENT = { records: ["r2", "r1"], fields: { title: "/name", subtitle: null, image: "/photo", link: "/url" }, caption: "Flats in Mitte" };

const session = (replyBlocks: ReplyBlocksCapability | null = { item_list: { layouts: ["carousel", "list"] } }): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Nico", chatModelOverride: null },
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "website_embed" },
  userMessage: { id: "message-1", content: QUERY },
  effectiveQuery: QUERY,
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: {} },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: { rules: [], omissions: [], matches: [] },
  replyBlocks,
} as unknown as PreparedSession);

const outcome = (over: Partial<SkillOutcome> = {}): TurnOutcome => ({
  kind: AGENT_SKILL_OUTCOME_KIND,
  skillName: "search_listings",
  outcome: { status: "completed", outputs: { structuredContent: LISTINGS }, ...over },
  stagedContext: [],
  steering: [],
  trace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
});

const harness = (reply: string, chunkSize = 7) => {
  const calls: ChatGatewayInput[] = [];
  const metrics: Array<{ name: string; labels: Record<string, string> | undefined }> = [];
  const fallback = vi.fn(async () => ({ text: "I could not find that.", declineReason: "content_gap" as const }));
  const gateway: ChatGateway = {
    async answer(input) {
      calls.push(input);
      return reply;
    },
    async *streamAnswer(input) {
      calls.push(input);
      for (let offset = 0; offset < reply.length; offset += chunkSize) {
        yield reply.slice(offset, offset + chunkSize);
      }
    },
  };
  let next = 0;
  const runtime = buildChatTurnRuntime({
    chatGateway: gateway,
    fallbackReplyComposer: { composeNoContext: fallback },
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    skillResultReplyBlocks: new SkillResultReplyBlocks({
      imageUrls: { forImage: (imageId) => ({ src: `https://api.example/reply-images/${imageId}/640`, srcSet: `https://api.example/reply-images/${imageId}/320 320w` }) },
      metrics: { incrementCounter: (name, options) => metrics.push({ name, labels: options.labels }) },
      newImageId: () => `image-${++next}`,
    }),
  });
  return { calls, metrics, fallback, renderer: runtime.skillResultRenderer };
};

const drain = async (generator: AsyncGenerator<string, TurnStreamResult>) => {
  const chunks: string[] = [];
  let step = await generator.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await generator.next();
  }
  return { chunks, result: step.value };
};

const envelope = (present: unknown, answer = LEAD) => JSON.stringify({ present, answer });

describe("skill result reply with the present head", () => {
  it("offers the head over the records, and builds cards from the whole reply", async () => {
    const { calls, metrics, renderer } = harness(envelope(PRESENT));

    const presentation = await renderer.render(outcome(), { session: session(), query: QUERY });

    expect(presentation.answer).toBe(LEAD);
    expect(calls[0]?.prompt).toContain('[r1] {"name":"Loft Mitte","rent":1850');
    expect(calls[0]?.prompt).toContain("Cards\nThe findings list the records");
    expect(calls[0]?.generation?.responseFormat?.schema).toMatchObject({ required: ["present", "answer"] });
    expect(presentation.replyBlocks?.stored[0]).toMatchObject({
      layout: "carousel",
      origin: { kind: "skill_result", skillName: "search_listings" },
      items: [{ key: "/structuredContent/1", title: "Altbau Mitte" }, { key: "/structuredContent/0", title: "Loft Mitte" }],
    });
    expect(presentation.replyBlocks?.presented[0]).not.toHaveProperty("origin");
    expect(presentation.replyBlocks?.presented[0]?.items[0]?.image?.src).toBe("https://api.example/reply-images/image-1/640");
    expect(presentation.replyBlocks?.toolImages).toEqual([
      { kind: "url", imageId: "image-1", url: "https://img.homes.example/altbau.jpg" },
      { kind: "url", imageId: "image-2", url: "https://img.homes.example/loft.jpg" },
    ]);
    expect(metrics).toContainEqual({ name: "reply_blocks_emitted_total", labels: { layout: "carousel", channel: "website_embed", source: "skill_result" } });
  });

  it("streams only the answer's text, and builds the same cards once the reply is whole", async () => {
    const { renderer } = harness(envelope(PRESENT));

    const { chunks, result } = await drain(renderer.stream!(outcome(), { session: session(), query: QUERY }));

    expect(chunks.join("")).toBe(LEAD);
    expect(result.finalPresentation.answer).toBe(LEAD);
    expect(result.finalPresentation.replyBlocks?.stored[0]?.items.map((item) => item.title)).toEqual(["Altbau Mitte", "Loft Mitte"]);
    expect(result.finalPresentation.skillName).toBe("search_listings");
  });

  it("builds no cards when the model shows no record", async () => {
    const { renderer } = harness(envelope({ ...PRESENT, records: [] }, "There are two listings."));

    const presentation = await renderer.render(outcome(), { session: session(), query: "How many listings are there?" });

    expect(presentation.answer).toBe("There are two listings.");
    expect(presentation.replyBlocks).toBeUndefined();
  });

  it("builds no cards for a blank reply, which falls back to a decline", async () => {
    const { renderer, fallback } = harness(envelope(PRESENT, "  "));

    const presentation = await renderer.render(outcome(), { session: session(), query: QUERY });
    const streamed = await drain(harness(envelope(PRESENT, "")).renderer.stream!(outcome(), { session: session(), query: QUERY }));

    expect(fallback).toHaveBeenCalled();
    expect(presentation.answer).toBe("I could not find that.");
    expect(presentation.replyBlocks).toBeUndefined();
    expect(streamed.result.finalPresentation.replyBlocks).toBeUndefined();
  });

  it("drops the skill's text when it only repeats its structured content as JSON", async () => {
    const { calls, renderer } = harness(envelope(PRESENT));

    await renderer.render(outcome({ answer: JSON.stringify(LISTINGS) }), { session: session(), query: QUERY });

    expect(calls[0]?.prompt).not.toContain('"photo":"https://img.homes.example/loft.jpg"');
    expect(calls[0]?.prompt).toContain("[r2]");
  });

  it("keeps text that says more than the records, after them", async () => {
    const { calls, renderer } = harness(envelope(PRESENT));

    await renderer.render(outcome({ answer: "Prices exclude heating." }), { session: session(), query: QUERY });

    expect(calls[0]?.prompt).toMatch(/\[r2\] .*\n\nPrices exclude heating\./s);
  });

  it("writes a text reply from records alone when the client renders no cards", async () => {
    const { calls, renderer } = harness("Loft Mitte and Altbau Mitte fit your budget.");

    const presentation = await renderer.render(outcome(), { session: session(null), query: QUERY });

    expect(renderer.supports(outcome())).toBe(true);
    expect(calls[0]?.prompt).toContain('[r1] {"name":"Loft Mitte"');
    expect(calls[0]?.prompt).not.toContain("Cards\n");
    expect(calls[0]?.generation).toBeUndefined();
    expect(presentation.replyBlocks).toBeUndefined();
  });

  it("claims no completed outcome that has neither text nor records", () => {
    const { renderer } = harness(LEAD);

    expect(renderer.supports(outcome({ outputs: undefined }))).toBe(false);
    expect(renderer.supports(outcome({ outputs: {} }))).toBe(false);
    expect(renderer.supports(outcome({ status: "failed" }))).toBe(false);
    expect(renderer.supports(outcome({ outputs: undefined, media: [{ kind: "image", imageId: "kept-1" }] }))).toBe(true);
  });
});

describe("present reply envelope", () => {
  it("reads the answer and the fields beside it", () => {
    expect(readPresentReplyEnvelope(envelope(PRESENT, " Hi "))).toEqual({ answer: "Hi", extras: { present: PRESENT } });
  });

  it("keeps the readable answer of a reply that does not parse, and no head", () => {
    expect(readPresentReplyEnvelope('{"present":{"records":["r1"]},"answer":"Two flats')).toEqual({ answer: "Two flats", extras: undefined });
    expect(readPresentReplyEnvelope("plain text")).toEqual({ answer: "", extras: undefined });
  });
});
