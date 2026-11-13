import { describe, expect, it, vi } from "vitest";

import type { ConnectorReplyBlocks } from "@radioso/connector-api";
import type { ReplyBlock, ReplyItem } from "@radioso/conversation-contract";

import { WhatsAppClient } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { WHATSAPP_MESSAGE_LIMITS } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappReplyCards.js";
import { WhatsAppReplyDelivery } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappReplyDelivery.js";
import { REPLY_CARDS_KEY } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappReplyTaps.js";
import { InMemoryWhatsAppPersistence } from "./support/inMemoryWhatsAppPersistence.js";

// Every row of the WhatsApp mapping (#1763, D7) through the real client, against a recorded Graph
// API: the bodies below are exactly what `/messages` receives.

const CONFIG = { phoneNumberId: "15550001111", accessToken: "wa-access-token" };
const TO = "14155551234";
const OUTBOUND = "local-7c1e";
const LEAD = "Three homes in Mitte fit your budget.";

type Recorded = Record<string, unknown>;

/** A Graph API that records each request body and answers with an id, or with the error a test sets for a call. */
const recordedGraph = (failures: Record<number, { status: number; message: string }> = {}) => {
  const bodies: Recorded[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as Recorded);
    const failure = failures[bodies.length];
    return failure
      ? new Response(JSON.stringify({ error: { message: failure.message } }), { status: failure.status })
      : new Response(JSON.stringify({ messages: [{ id: `wamid.sent.${bodies.length}` }] }), { status: 200 });
  });
  return { bodies, fetch };
};

const setup = (failures: Record<number, { status: number; message: string }> = {}) => {
  const graph = recordedGraph(failures);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const counts: Array<Record<string, string> | undefined> = [];
  const persistence = new InMemoryWhatsAppPersistence();
  const client = new WhatsAppClient({ fetch: graph.fetch, sleep: async () => undefined, logger });
  const delivery = new WhatsAppReplyDelivery({
    client,
    persistence,
    logger,
    metrics: { incrementCounter: (name, options) => (name === "whatsapp_block_send_total" ? counts.push(options.labels) : undefined) },
  });
  return { ...graph, logger, counts, persistence, delivery };
};

const item = (index: number, overrides: Partial<ReplyItem> = {}): ReplyItem => ({
  key: `/results/${index}`,
  title: `Home ${index}`,
  image: { src: `https://api.example/api/v1/public/reply-images/img-${index}/640`, alt: "", width: 640, height: 480 },
  actions: [{ type: "open", url: `https://homes.example/listing-${index}` }],
  ...overrides,
});

const block = (items: ReplyItem[], overrides: Partial<ReplyBlock> = {}): ReplyBlock => ({
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "single",
  caption: "Homes in Mitte",
  items: items.map((entry) => (overrides.selection === "none" ? entry : { ...entry, actions: [...entry.actions, { type: "select" }] })),
  buttonLabels: { select: "Scegli", open: "Apri" },
  ...overrides,
});

const cards = (value: ReplyBlock): ConnectorReplyBlocks => ({ messageId: "11111111-1111-4111-8111-111111111111", blocks: [value] });

const deliver = async (harness: ReturnType<typeof setup>, value: ReplyBlock, text = LEAD) => {
  await harness.persistence.createMessageLog({
    wamid: OUTBOUND,
    direction: "outbound",
    workspaceId: "workspace-1",
    waId: TO,
    messageType: "interactive",
    payload: { text, inbound_wamids: ["wamid-in-1"], [REPLY_CARDS_KEY]: cards(value) },
    status: "processing",
  });
  return harness.delivery.deliver({ config: CONFIG, workspaceId: "workspace-1", waId: TO, outboundWamid: OUTBOUND, text, cards: cards(value) });
};

const tap = (index: number) => `rb:${OUTBOUND}:0:${index}`;
const header = (index: number) => ({ type: "image", image: { link: `https://api.example/api/v1/public/reply-images/img-${index}/640` } });

describe("WhatsApp reply cards", () => {
  it("sends selectable cards with pictures as a carousel with one quick-reply button per card, the reply's text as its body", async () => {
    const harness = setup();

    await deliver(harness, block([item(0), item(1, { description: "2 rooms\n68 m²" }), item(2)]));

    expect(harness.bodies).toEqual([{
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: {
        type: "carousel",
        body: { text: LEAD },
        action: {
          cards: [0, 1, 2].map((index) => ({
            card_index: index,
            type: "cta_url",
            header: header(index),
            body: { text: index === 1 ? "Home 1\n2 rooms 68 m²" : `Home ${index}` },
            action: { buttons: [{ type: "quick_reply", quick_reply: { id: tap(index), title: "Scegli" } }] },
          })),
        },
      },
    }]);
    expect(harness.counts).toEqual([{ message_type: "carousel", outcome: "sent" }]);
  });

  it("sends cards that are only shown, all with pictures and pages, as a carousel with one URL button per card", async () => {
    const harness = setup();

    await deliver(harness, block([item(0), item(1)], { selection: "none" }));

    const interactive = harness.bodies[0]?.interactive as { action: { cards: Array<{ action: unknown }> } };
    expect(interactive.action.cards.map((card) => card.action)).toEqual([0, 1].map((index) => ({
      name: "cta_url",
      parameters: { display_text: "Apri", url: `https://homes.example/listing-${index}` },
    })));
    expect(harness.counts).toEqual([{ message_type: "carousel", outcome: "sent" }]);
  });

  it("sends a gallery whose pictures are not all pages as the text, then at most four image messages, each captioned with its title", async () => {
    const harness = setup();
    const photos = [0, 1, 2, 3, 4, 5].map((index) => item(index, { title: `Room ${index}`, actions: index === 0 ? [{ type: "open", url: "https://stay.example/rooms" }] : [] }));

    await deliver(harness, block(photos, { selection: "none", layout: "grid" }));

    expect(harness.bodies).toEqual([
      { messaging_product: "whatsapp", to: TO, type: "text", text: { body: LEAD } },
      { messaging_product: "whatsapp", to: TO, type: "image", image: { link: header(0).image.link, caption: "Room 0\nhttps://stay.example/rooms" } },
      ...[1, 2, 3].map((index) => ({ messaging_product: "whatsapp", to: TO, type: "image", image: { link: header(index).image.link, caption: `Room ${index}` } })),
    ]);
    expect(harness.bodies).toHaveLength(1 + WHATSAPP_MESSAGE_LIMITS.galleryImages);
  });

  it("sends one card that is only shown as the text, then an image message", async () => {
    const harness = setup();

    await deliver(harness, block([item(0)], { selection: "none" }));

    expect(harness.bodies.map((body) => body.type)).toEqual(["text", "image"]);
    expect(harness.counts).toEqual([{ message_type: "image", outcome: "sent" }]);
  });

  it("sends one card to pick as a reply-button message with its picture as the header", async () => {
    const harness = setup();

    await deliver(harness, block([item(0)]));

    expect(harness.bodies).toEqual([{
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: {
        type: "button",
        header: header(0),
        body: { text: LEAD },
        action: { buttons: [{ type: "reply", reply: { id: tap(0), title: "Scegli" } }] },
      },
    }]);
  });

  it("sends cards to pick without pictures as a list message, cutting titles to 24 characters and keeping the whole in the description", async () => {
    const harness = setup();
    const longTitle = "Altbau with balcony near Rosenthaler Platz";
    const items = [item(0, { image: undefined, description: "2 rooms" }), item(1, { image: undefined, title: longTitle })];

    await deliver(harness, block(items, { layout: "list" }));

    expect(harness.bodies).toEqual([{
      messaging_product: "whatsapp",
      to: TO,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: LEAD },
        action: {
          button: "Scegli",
          sections: [{
            title: "Homes in Mitte",
            rows: [
              { id: tap(0), title: "Home 0", description: "2 rooms" },
              { id: tap(1), title: "Altbau with balcony nea…", description: longTitle },
            ],
          }],
        },
      },
    }]);
    const rows = (harness.bodies[0]?.interactive as { action: { sections: Array<{ rows: Array<{ id: string; title: string }> }> } }).action.sections[0].rows;
    for (const row of rows) {
      expect(Array.from(row.title).length).toBeLessThanOrEqual(WHATSAPP_MESSAGE_LIMITS.listRowTitle);
      expect(row.id.length).toBeLessThanOrEqual(200);
    }
  });

  it("sends the text alone for cards no WhatsApp message carries: only shown, without pictures", async () => {
    const harness = setup();

    await deliver(harness, block([item(0, { image: undefined }), item(1, { image: undefined })], { selection: "none", layout: "list" }));

    expect(harness.bodies).toEqual([{ messaging_product: "whatsapp", to: TO, type: "text", text: { body: LEAD } }]);
    expect(harness.counts).toEqual([{ message_type: "none", outcome: "unsupported" }]);
  });

  it("sends a text too long for the body first, and puts the block's caption in the carousel's body", async () => {
    const harness = setup();
    const longLead = "A".repeat(WHATSAPP_MESSAGE_LIMITS.interactiveBody + 1);

    await deliver(harness, block([item(0), item(1)]), longLead);

    expect(harness.bodies[0]).toEqual({ messaging_product: "whatsapp", to: TO, type: "text", text: { body: longLead } });
    expect((harness.bodies[1]?.interactive as { body: unknown }).body).toEqual({ text: "Homes in Mitte" });
  });

  it("keeps each card's text within 160 characters and two lines", async () => {
    const harness = setup();

    await deliver(harness, block([item(0, { title: "T".repeat(160), description: "line\nline\nline" }), item(1)]));

    const first = (harness.bodies[0]?.interactive as { action: { cards: Array<{ body: { text: string } }> } }).action.cards[0].body.text;
    expect(Array.from(first).length).toBeLessThanOrEqual(WHATSAPP_MESSAGE_LIMITS.cardBody);
    expect(first.split("\n").length - 1).toBeLessThanOrEqual(WHATSAPP_MESSAGE_LIMITS.cardBodyLineBreaks);
  });

  it("sends the text with a numbered list when the reply left out the label the buttons need", async () => {
    const harness = setup();

    await deliver(harness, block([item(0), item(1)], { buttonLabels: { open: "Apri" } }));

    expect(harness.bodies).toEqual([{
      messaging_product: "whatsapp",
      to: TO,
      type: "text",
      text: { body: `${LEAD}\n\n1. Home 0\nhttps://homes.example/listing-0\n2. Home 1\nhttps://homes.example/listing-1` },
    }]);
    expect(harness.counts).toEqual([{ message_type: "carousel", outcome: "labels_missing" }, { message_type: "text_list", outcome: "sent" }]);
  });

  it("delivers the text and a numbered list when Graph refuses the carousel, and counts both", async () => {
    const harness = setup({ 1: { status: 400, message: "Media download failed for +14155551234" } });

    const sent = await deliver(harness, block([item(0), item(1)]));

    expect(sent).toEqual({ wamid: "wamid.sent.2" });
    expect(harness.bodies[1]).toEqual({
      messaging_product: "whatsapp",
      to: TO,
      type: "text",
      text: { body: `${LEAD}\n\n1. Home 0\nhttps://homes.example/listing-0\n2. Home 1\nhttps://homes.example/listing-1` },
    });
    expect(harness.counts).toEqual([{ message_type: "carousel", outcome: "failed" }, { message_type: "text_list", outcome: "sent" }]);
    expect(JSON.stringify(harness.logger.warn.mock.calls)).not.toContain("14155551234");
  });

  it("sends only the list when the carousel fails after its text already went, and never throws once part of the reply went", async () => {
    const harness = setup({ 2: { status: 400, message: "bad" }, 3: { status: 500, message: "down" } });

    const sent = await deliver(harness, block([item(0), item(1)]), "B".repeat(WHATSAPP_MESSAGE_LIMITS.interactiveBody + 1));

    expect(sent).toEqual({ wamid: "wamid.sent.1" });
    expect(harness.bodies[2]).toMatchObject({ type: "text", text: { body: "1. Home 0\nhttps://homes.example/listing-0\n2. Home 1\nhttps://homes.example/listing-1" } });
    expect(harness.counts).toEqual([{ message_type: "carousel", outcome: "failed" }, { message_type: "text_list", outcome: "failed" }]);
  });

  it("throws, for the reply to be retried, when nothing of it reached Graph", async () => {
    const harness = setup({ 1: { status: 400, message: "bad" }, 2: { status: 500, message: "down" } });

    await expect(deliver(harness, block([item(0), item(1)]))).rejects.toMatchObject({ statusCode: 500 });
  });

  describe("when Graph reports later that it could not deliver the cards", () => {
    const failedLater = async (options: { now?: Date } = {}) => {
      const harness = setup();
      await deliver(harness, block([item(0), item(1)]));
      const delivery = new WhatsAppReplyDelivery({
        client: new WhatsAppClient({ fetch: harness.fetch, logger: harness.logger }),
        persistence: harness.persistence,
        logger: harness.logger,
        metrics: { incrementCounter: (_name, metric) => harness.counts.push(metric.labels) },
        ...(options.now ? { now: () => options.now! } : {}),
      });
      return { harness, delivery };
    };

    it("sends the reply's text and the numbered list, once, however often the failure is reported", async () => {
      const { harness, delivery } = await failedLater();

      await delivery.handleFailedStatus({ workspaceId: "workspace-1", wamid: "wamid.sent.1", errorCode: 131053, config: CONFIG });
      await delivery.handleFailedStatus({ workspaceId: "workspace-1", wamid: "wamid.sent.1", errorCode: 131053, config: CONFIG });

      expect(harness.bodies).toHaveLength(2);
      expect(harness.bodies[1]).toMatchObject({ to: TO, type: "text", text: { body: expect.stringContaining(`${LEAD}\n\n1. Home 0`) } });
      expect(harness.counts.slice(1)).toEqual([{ message_type: "carousel", outcome: "failed" }, { message_type: "text_list", outcome: "sent" }]);
    });

    it("sends nothing outside the 24-hour service window", async () => {
      const { harness, delivery } = await failedLater({ now: new Date(Date.now() + 25 * 60 * 60 * 1000) });

      await delivery.handleFailedStatus({ workspaceId: "workspace-1", wamid: "wamid.sent.1", errorCode: 131053, config: CONFIG });

      expect(harness.bodies).toHaveLength(1);
    });

    it("acts on no message that was not a reply's cards, nor on another workspace's", async () => {
      const { harness, delivery } = await failedLater();

      await delivery.handleFailedStatus({ workspaceId: "workspace-1", wamid: "wamid.unknown", errorCode: 131053, config: CONFIG });
      await delivery.handleFailedStatus({ workspaceId: "workspace-2", wamid: "wamid.sent.1", errorCode: 131053, config: CONFIG });

      expect(harness.bodies).toHaveLength(1);
    });
  });
});
