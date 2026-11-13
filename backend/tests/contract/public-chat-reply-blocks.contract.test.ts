import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { resetRateLimiterState } from "../../src/app/http/middleware/anonymousRateLimiter.js";
import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { InMemoryDocumentImages } from "../support/inMemoryDocumentImages.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

type TestApp = ReturnType<typeof createTestApp>["app"];

const REPLY_BLOCKS = { "reply.blocks": { item_list: { layouts: ["carousel", "grid"] } } };

const envelope = JSON.stringify({
  coverage: "answered_sufficient_evidence",
  requestFocus: "hiking guides",
  outcome: "answer",
  answer: "We carry two hiking guides[[1]][[2]].",
  v: 2,
  claims: [[1], [2]],
  suggestions: [{ text: "Which one suits beginners?", kind: "deeper", contextIndex: 1 }],
  grounding: "degraded",
  adherence: [],
  present: { images: ["m1", "m2"], caption: "Two hiking guides" },
});

const scriptedGateway: ChatGateway = {
  async answer() {
    return envelope;
  },
  async *streamAnswer() {
    for (let offset = 0; offset < envelope.length; offset += 13) {
      yield envelope.slice(offset, offset + 13);
    }
  },
};

const readSse = (res: NodeJS.ReadableStream & { setEncoding(encoding: string): void }, callback: (error: Error | null, body: string) => void) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => { body += chunk; });
  res.on("end", () => callback(null, body));
};

const sseEvents = (body: string): Array<{ event: string; data: Record<string, unknown> }> =>
  body.split("\n\n").flatMap((frame) => {
    const event = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });

/** A public chat over two guides, each with a stored cover, answered by a model that presents both. */
const guidesWithCovers = async () => {
  const documentImages = new InMemoryDocumentImages();
  const { app } = createTestApp({
    chatGateway: scriptedGateway,
    documentImages,
    turnRouter: {
      async classify() {
        return { route: "retrieval" as const, framing: { isIdentityQuestion: false } };
      },
    },
  });
  const session = await issueTestSession(app, `reply-blocks-${Math.random().toString(36).slice(2)}@example.com`);
  // The operator turns reply cards on, which every agent starts without.
  const agents = await request(app).get("/api/v1/agents").set(adminSessionHeaders(session)).expect(200);
  await request(app)
    .put(`/api/v1/agents/${String(agents.body.agents[0].id)}`)
    .set(adminSessionHeaders(session))
    .send({ replyCardsEnabled: true })
    .expect(200);
  for (const [index, title] of ["Alpine Flowers", "Trail Maps"].entries()) {
    const created = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title, content: `${title} is a hiking guide we carry.`, metadata: { sourceUrl: `https://shop.example/books/${index}` } });
    const documentId = String(created.body.documentId ?? created.body.id);
    documentImages.add(session.workspaceId, {
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      documentId,
      chunkId: null,
      role: "primary",
      position: 0,
      alt: "",
      caption: null,
      width: 1280,
      height: 960,
      sha256: `sha-${index}`,
    });
  }
  const settings = await request(app)
    .put("/api/v1/settings/general")
    .set(adminSessionHeaders(session))
    .send({ anonymousChatEnabled: true });
  const chatToken = String(settings.body.anonymousChatUrl).split("/chat/")[1];
  const publicSession = await request(app)
    .post(`/api/v1/public/chat/${chatToken}/sessions`)
    .send({ channel: "anonymous_link" });
  return { app, chatToken, publicSessionToken: String(publicSession.body.publicSessionToken) };
};

const ask = (app: TestApp, chatToken: string, publicSessionToken: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/public/chat/${chatToken}`)
    .set("x-radioso-public-session", publicSessionToken)
    .send({ message: "Which hiking guides do you have?", ...body });

describe("public chat reply blocks", () => {
  beforeEach(() => {
    resetRateLimiterState();
  });

  it("streams chunks, then one block event, then done with the blocks, then suggestions", async () => {
    const { app, chatToken, publicSessionToken } = await guidesWithCovers();

    const response = await request(app)
      .post(`/api/v1/public/chat/${chatToken}`)
      .set("x-radioso-public-session", publicSessionToken)
      .buffer(true)
      .parse(readSse as never)
      .send({ message: "Which hiking guides do you have?", stream: true, clientContextCapabilities: REPLY_BLOCKS });

    expect(response.status).toBe(200);
    const events = sseEvents(String(response.body));
    const order = events.map(({ event }) => event).filter((event) => ["chunk", "block", "done", "suggestions"].includes(event));
    const firstBlock = order.indexOf("block");
    expect(order.slice(0, firstBlock).every((event) => event === "chunk")).toBe(true);
    expect(order.slice(firstBlock)).toEqual(["block", "done", "suggestions"]);

    const block = events.find(({ event }) => event === "block")?.data;
    const done = events.find(({ event }) => event === "done")?.data;
    expect(block?.assistantMessageId).toBe(done?.assistantMessageId);
    expect(done?.blocks).toEqual([block?.block]);
    expect(block?.block).toMatchObject({ type: "item_list", layout: "carousel", caption: "Two hiking guides" });
    const items = (block?.block as { items: Array<{ title: string; actions: unknown[]; image: { src: string; srcSet: string } }> }).items;
    expect(items.map(({ title, actions }) => ({ title, actions })).sort((left, right) => left.title.localeCompare(right.title))).toEqual([
      { title: "Alpine Flowers", actions: [{ type: "open", url: "https://shop.example/books/0" }] },
      { title: "Trail Maps", actions: [{ type: "open", url: "https://shop.example/books/1" }] },
    ]);
    for (const { image } of items) {
      expect(image.src).toMatch(/\/api\/v1\/public\/reply-images\/00000000-0000-4000-8000-00000000000[12]\/640$/);
      expect(image.srcSet).toContain("/320 320w");
    }
  });

  it("returns the blocks on a JSON reply and replays them identically from history", async () => {
    const { app, chatToken, publicSessionToken } = await guidesWithCovers();

    const reply = await ask(app, chatToken, publicSessionToken, { stream: false, clientContextCapabilities: REPLY_BLOCKS });
    expect(reply.status).toBe(200);
    expect(reply.body.blocks).toHaveLength(1);

    const cookie = (reply.headers["set-cookie"] as unknown as string[] | undefined)
      ?.find((entry) => entry.startsWith("anon_session_"));
    const history = await request(app)
      .get(`/api/v1/public/chat/${chatToken}/history/${reply.body.conversationId}`)
      .set("x-radioso-public-session", publicSessionToken)
      .set("Cookie", cookie ?? "");
    expect(history.status).toBe(200);
    const assistant = (history.body.messages as Array<{ id: string; blocks?: unknown }>)
      .find((message) => message.id === reply.body.assistantMessageId);
    expect(assistant?.blocks).toEqual(reply.body.blocks);
  });

  it("answers in text alone for a client that declares no reply blocks", async () => {
    const { app, chatToken, publicSessionToken } = await guidesWithCovers();

    const reply = await ask(app, chatToken, publicSessionToken, { stream: false });

    expect(reply.status).toBe(200);
    expect(reply.body.answer).toBe("We carry two hiking guides.");
    expect(reply.body).not.toHaveProperty("blocks");
  });
});
