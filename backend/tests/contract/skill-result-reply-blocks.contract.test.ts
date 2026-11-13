import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { SkillExecutorRegistry, type SkillDispatchResult } from "../../src/modules/skills/public.js";
import { adminSessionHeaders, createTestApp, issueTestSession, publishTestAgentBaseline } from "../support/testApp.js";

const REPLY_BLOCKS = { "reply.blocks": { item_list: { layouts: ["carousel", "grid", "list"] } } };
const LEAD = "Two flats in Mitte fit your budget.";

/** What the bound search returns: invented listings, on `.example` domains. */
const LISTINGS = [
  { name: "Loft on Torstrasse", area: "Mitte", url: "https://homes.example/listings/loft-torstrasse", photos: [{ url: "https://img.homes.example/loft.jpg?sig=abc" }] },
  { name: "Garden flat on Linienstrasse", area: "Mitte", url: "https://homes.example/listings/garden-flat", photos: [{ url: "https://img.homes.example/garden.jpg" }] },
];

const PRESENT = {
  records: ["r2", "r1"],
  fields: { title: "/name", subtitle: "/area", image: "/photos/0/url", link: "/url" },
  caption: "Flats in Mitte",
};

/** The agent's model: the skill-result reply answers with the envelope its offer asks for; any other call with plain text. */
const scriptedGateway = (calls: ChatGatewayInput[]): ChatGateway => {
  const reply = (input: ChatGatewayInput) => {
    calls.push(input);
    return input.generation?.responseFormat?.name === "assistant_reply_with_present"
      ? JSON.stringify({ present: PRESENT, answer: LEAD })
      : LEAD;
  };
  return {
    async answer(input) {
      return reply(input);
    },
    async *streamAnswer(input) {
      const text = reply(input);
      for (let offset = 0; offset < text.length; offset += 11) {
        yield text.slice(offset, offset + 11);
      }
    },
  };
};

const listingsSkill = new SkillExecutorRegistry([{
  kind: "internal",
  adapter: "test_listing_search",
  executor: {
    async dispatch(): Promise<SkillDispatchResult> {
      return { disposition: "settled", outcome: { status: "completed", outputs: { structuredContent: LISTINGS } } };
    },
  },
}]);

const sseEvents = (body: string): Array<{ event: string; data: Record<string, unknown> }> =>
  body.split("\n\n").flatMap((frame) => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });

/** A workspace whose agent answers every turn from a bound listing search that returns records and no text. */
const listingAgent = async (replyCardsEnabled = true) => {
  const calls: ChatGatewayInput[] = [];
  const { app, dependencies, repositories } = createTestApp({ chatGateway: scriptedGateway(calls), skillExecutorRegistry: listingsSkill });
  const session = await issueTestSession(app, `skill-result-cards-${Math.random().toString(36).slice(2)}@example.com`);
  const agent = await dependencies.agentService.resolve(session.workspaceId);
  await request(app).put(`/api/v1/agents/${agent.id}`).set(adminSessionHeaders(session)).send({ replyCardsEnabled }).expect(200);
  await repositories.agentSkillRepository.create({
    workspaceId: session.workspaceId,
    agentId: agent.id,
    skillName: "search_listings",
    kind: "external_mcp",
    invocationMode: "agent_selectable",
    enabled: true,
    targetType: "mcp_connection",
    targetId: "test-listing-connection",
    config: { execution: { kind: "internal", adapter: "test_listing_search" } },
  });
  await repositories.agentRepository.createDirective(agent.id, session.workspaceId, {
    name: "listing-search",
    condition: { kind: "always" },
    action: "Search the listings and answer from what they return.",
    binding: { kind: "skill", skillName: "search_listings" },
  });
  await publishTestAgentBaseline(app, { workspaceId: session.workspaceId, agentId: agent.id });
  return { app, session, calls };
};

describe("cards from a skill's result over authenticated chat", () => {
  it("streams the cards built from the skill's records, and history replays them without the server's origin", async () => {
    const { app, session, calls } = await listingAgent();
    const headers = adminSessionHeaders(session);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(headers)
      .buffer(true)
      .parse(((res: NodeJS.ReadableStream & { setEncoding(encoding: string): void }, callback: (error: Error | null, body: string) => void) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => callback(null, body));
      }) as never)
      .send({ message: "Flats in Mitte under 2,000?", stream: true, clientContextCapabilities: REPLY_BLOCKS });

    expect(response.status).toBe(200);
    const events = sseEvents(String(response.body));
    const done = events.find(({ event }) => event === "done")?.data;
    expect(done?.answer).toBe(LEAD);
    const blocks = done?.blocks as Array<{ layout: string; items: Array<{ title: string; image?: { src: string }; actions: unknown[] }> }>;
    expect(blocks[0]).toMatchObject({
      layout: "carousel",
      caption: "Flats in Mitte",
      items: [
        { title: "Garden flat on Linienstrasse", description: "Mitte", actions: [{ type: "open", url: "https://homes.example/listings/garden-flat" }] },
        { title: "Loft on Torstrasse", actions: [{ type: "open", url: "https://homes.example/listings/loft-torstrasse" }] },
      ],
    });
    expect(blocks[0]?.items[0]?.image?.src).toMatch(/\/api\/v1\/public\/reply-images\/[0-9a-f-]{36}\/640$/);
    expect(blocks[0]).not.toHaveProperty("origin");
    expect(String(response.body)).not.toContain("sig=abc");
    const composed = calls.find((call) => call.usageContext.attemptKey === "stream_skill_result");
    expect(composed?.prompt).toContain('[r1] {"name":"Loft on Torstrasse"');

    const history = await request(app).get(`/api/v1/history/chat/${String(done?.conversationId)}`).set(headers);
    const assistant = (history.body.messages as Array<{ id: string; blocks?: unknown }>).find((message) => message.id === done?.assistantMessageId);
    expect(assistant?.blocks).toEqual(blocks);
  });

  it("leaves a records-only result unanswered by the skill for a client that declares no cards, as before cards existed", async () => {
    const { app, session, calls } = await listingAgent();

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "Flats in Mitte under 2,000?", stream: false });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("blocks");
    // No reply is written from the skill's records, so no record or handle reaches any prompt.
    expect(calls.some((call) => call.usageContext.attemptKey === "skill_result")).toBe(false);
    expect(calls.some((call) => /\[r\d+\]|Garden flat on Linienstrasse/.test(call.prompt))).toBe(false);
  });
  it("shows no cards and leaves a records-only result unanswered by the skill while the agent's reply cards switch is off", async () => {
    const { app, session, calls } = await listingAgent(false);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set(adminSessionHeaders(session))
      .send({ message: "Flats in Mitte under 2,000?", stream: false, clientContextCapabilities: REPLY_BLOCKS });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty("blocks");
    expect(calls.some((call) => call.usageContext.attemptKey === "skill_result")).toBe(false);
    expect(calls.some((call) => call.generation?.responseFormat?.name === "assistant_reply_with_present")).toBe(false);
  });
});
