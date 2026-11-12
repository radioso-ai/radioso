import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { InMemoryDocumentImages } from "../support/inMemoryDocumentImages.js";
import { adminSessionHeaders, createTestApp, issueTestSession } from "../support/testApp.js";

const REPLY_BLOCKS = { "reply.blocks": { item_list: { layouts: ["carousel", "grid"] } } };

// In schema order: `present` is written ahead of `answer`.
const envelope = JSON.stringify({
  coverage: "answered_sufficient_evidence",
  requestFocus: "hiking guides",
  outcome: "answer",
  adherencePlan: [],
  present: { images: ["m1", "m2"], caption: "Two hiking guides" },
  answer: "Here are the hiking guides we carry[[1]][[2]].",
  v: 2,
  claims: [[1], [2]],
  suggestions: [],
  grounding: "degraded",
  adherence: [],
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

/** A workspace with two guides, each with a stored cover, answered by a model that presents both. */
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
  const session = await issueTestSession(app, `assistant-reply-blocks-${Math.random().toString(36).slice(2)}@example.com`);
  for (const [index, title] of ["Alpine Flowers", "Trail Maps"].entries()) {
    const created = await request(app)
      .post("/api/v1/document/")
      .set(adminSessionHeaders(session))
      .send({ title, content: `${title} is a hiking guide we carry.`, metadata: { sourceUrl: `https://shop.example/books/${index}` } });
    documentImages.add(session.workspaceId, {
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      documentId: String(created.body.documentId ?? created.body.id),
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
  return { app, session };
};

const streamTurn = (app: Awaited<ReturnType<typeof guidesWithCovers>>["app"], headers: Record<string, string>, body: Record<string, unknown>) =>
  request(app)
    .post("/api/v1/assistant/chat")
    .set(headers)
    .buffer(true)
    .parse(readSse as never)
    .send({ message: "Which hiking guides do you have?", stream: true, ...body });

describe("authenticated chat reply blocks", () => {
  it("streams a block event for a client that declares reply blocks, and history replays it", async () => {
    const { app, session } = await guidesWithCovers();
    const headers = adminSessionHeaders(session);

    const response = await streamTurn(app, headers, { clientContextCapabilities: REPLY_BLOCKS });

    expect(response.status).toBe(200);
    const events = sseEvents(String(response.body));
    const block = events.find(({ event }) => event === "block")?.data;
    const done = events.find(({ event }) => event === "done")?.data;
    expect(block?.block).toMatchObject({ type: "item_list", layout: "carousel", caption: "Two hiking guides" });
    expect(block?.assistantMessageId).toBe(done?.assistantMessageId);
    expect(done?.blocks).toEqual([block?.block]);
    expect(done?.answer).toBe("Here are the hiking guides we carry.");

    const history = await request(app)
      .get(`/api/v1/history/chat/${String(done?.conversationId)}`)
      .set(headers);
    expect(history.status).toBe(200);
    const assistant = (history.body.messages as Array<{ id: string; blocks?: unknown }>)
      .find((message) => message.id === done?.assistantMessageId);
    expect(assistant?.blocks).toEqual([block?.block]);
  });

  it("streams no block for a client that declares none", async () => {
    const { app, session } = await guidesWithCovers();

    const response = await streamTurn(app, adminSessionHeaders(session), {});

    expect(response.status).toBe(200);
    const events = sseEvents(String(response.body));
    expect(events.some(({ event }) => event === "block")).toBe(false);
    expect(events.find(({ event }) => event === "done")?.data).not.toHaveProperty("blocks");
  });
});
