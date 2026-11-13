import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectorChatPort, ConnectorReplyBlocks } from "@radioso/connector-api";

import type { WhatsAppClient } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { WhatsAppMessageHandler } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import { REPLY_CARDS_KEY } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappReplyTaps.js";
import { findInboundMessageInPayload } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappWebhook.js";
import { InMemoryWhatsAppPersistence } from "./support/inMemoryWhatsAppPersistence.js";

// A tap on a reply's card comes back as the pick of that card (#1763): the button's id names the
// reply's outbound row and the card's place, and the row holds the ids the host checks.

const WORKSPACE = "workspace-1";
const CUSTOMER = "14155551234";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const REPLY = "local-reply-1";

const CARDS: ConnectorReplyBlocks = {
  messageId: MESSAGE_ID,
  blocks: [{
    type: "item_list",
    id: "b1",
    layout: "carousel",
    selection: "single",
    caption: "Homes",
    items: ["Casa Blu", "Villa Rosa"].map((title, index) => ({ key: `/results/${index}`, title, actions: [{ type: "select" as const }] })),
  }],
};

/** A webhook body carrying one inbound message. */
const webhook = (message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: "15550001111" },
        contacts: [{ wa_id: CUSTOMER, profile: { name: "Alicia" } }],
        messages: [{ id: "wamid-tap-1", from: CUSTOMER, timestamp: "1773828000", context: { from: "15550001111", id: "wamid.sent.1" }, ...message }],
      },
    }],
  }],
});

const parse = (message: Record<string, unknown>) => findInboundMessageInPayload(WORKSPACE, webhook(message), "wamid-tap-1");

describe("reading a tap from the webhook", () => {
  it.each([
    ["a reply button", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: `rb:${REPLY}:0:1`, title: "Scegli" } } }, "Scegli"],
    ["a list row", { type: "interactive", interactive: { type: "list_reply", list_reply: { id: `rb:${REPLY}:0:1`, title: "Villa Rosa", description: "2 rooms" } } }, "Villa Rosa"],
    ["a carousel's quick reply in a shape Meta does not document", { type: "interactive", interactive: { type: "quick_reply", quick_reply: { id: `rb:${REPLY}:0:1`, title: "Scegli" } } }, "Scegli"],
    ["a quick-reply button message", { type: "button", button: { payload: `rb:${REPLY}:0:1`, text: "Scegli" } }, "Scegli"],
  ])("reads %s as a tap with the id it carried and the words on it", (_case, message, title) => {
    expect(parse(message)).toMatchObject({ tap: { id: `rb:${REPLY}:0:1`, title }, textBody: title });
  });

  it("reads a text message as no tap", () => {
    expect(parse({ type: "text", text: { body: "Hello" } })).not.toHaveProperty("tap");
  });
});

describe("answering a tap", () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-18T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const setup = async (options: { replyTo?: string; conversation?: boolean } = {}) => {
    const persistence = new InMemoryWhatsAppPersistence();
    if (options.conversation ?? true) {
      await persistence.upsertContact({ workspaceId: WORKSPACE, waId: CUSTOMER, profileName: "Alicia", conversationId: "conversation-1", lastMessageAt: new Date("2026-03-18T09:59:00.000Z") });
    }
    await persistence.createMessageLog({
      wamid: REPLY,
      direction: "outbound",
      workspaceId: WORKSPACE,
      waId: options.replyTo ?? CUSTOMER,
      messageType: "interactive",
      payload: { text: "Two homes fit.", inbound_wamids: ["wamid-earlier"], [REPLY_CARDS_KEY]: CARDS },
      status: "replied",
    });
    const chat = {
      imageAllowance: vi.fn<ConnectorChatPort["imageAllowance"]>(async () => null),
      answer: vi.fn<ConnectorChatPort["answer"]>(async () => ({ conversationId: "conversation-1", answer: "Villa Rosa it is.", outcome: "answered" })),
    };
    const client = {
      sendTextMessage: vi.fn<WhatsAppClient["sendTextMessage"]>(async () => ({ wamid: "wamid.sent.2" })),
      sendMessage: vi.fn<WhatsAppClient["sendMessage"]>(async () => ({ wamid: "wamid.sent.3" })),
      downloadImage: vi.fn<WhatsAppClient["downloadImage"]>(),
    };
    const handler = new WhatsAppMessageHandler({
      db: { query: vi.fn() },
      logger,
      chat,
      state: {
        getConfig: async () => ({ enabled: true, config: { phone_number_id: "15550001111", access_token: "wa-access-token", conversation_timeout_hours: "24" } }),
        setErrorStatus: vi.fn(),
      },
      client,
      persistence,
      debounceMs: 10,
    });
    const send = async (...messages: Array<Record<string, unknown>>) => {
      for (const [index, message] of messages.entries()) {
        const inbound = findInboundMessageInPayload(WORKSPACE, webhook({ ...message, id: `wamid-in-${index}` }), `wamid-in-${index}`)!;
        await persistence.createInboundMessageLog({ wamid: inbound.wamid, workspaceId: WORKSPACE, waId: CUSTOMER, messageType: inbound.type, payload: inbound.payload });
        await handler.handleInboundMessage(inbound);
      }
      await vi.advanceTimersByTimeAsync(10);
    };
    return { chat, client, persistence, send };
  };

  const buttonTap = (id: string, title = "Scegli") => ({ type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } });

  it.each([
    ["a quick-reply button", buttonTap(`rb:${REPLY}:0:1`)],
    ["a list row", { type: "interactive", interactive: { type: "list_reply", list_reply: { id: `rb:${REPLY}:0:1`, title: "Villa Rosa" } } }],
  ])("turns a tap on %s into the pick of the card it names, on the card's own words", async (_case, message) => {
    const { chat, client, send } = await setup();

    await send(message);

    expect(chat.answer).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      query: "Villa Rosa",
      selection: { messageId: MESSAGE_ID, blockId: "b1", itemKey: "/results/1" },
    }));
    expect(client.sendTextMessage).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ text: "Villa Rosa it is." }));
  });

  it("leaves a tap on a button the connector did not send, such as a template's, unsupported as it always was", async () => {
    const { chat, persistence, send } = await setup();

    await send(buttonTap("btn-1", "Yes please"));

    expect(chat.answer).not.toHaveBeenCalled();
    expect(persistence.messageLogs.get("wamid-in-0")?.status).toBe("skipped");
  });

  it.each([
    ["a reply the log no longer holds", buttonTap("rb:local-gone:0:0", "Yes please"), "unknown_reply"],
    ["a card the reply did not show", buttonTap(`rb:${REPLY}:0:7`, "Yes please"), "unknown_item"],
  ])("answers a tap on %s as the words on its button, logging ids only", async (_case, message, reason) => {
    const { chat, send } = await setup();

    await send(message);

    const [call] = chat.answer.mock.calls[0];
    expect(call.query).toBe("Yes please");
    expect(call).not.toHaveProperty("selection");
    expect(logger.info).toHaveBeenCalledWith({ workspaceId: WORKSPACE, wamid: "wamid-in-0", reason }, expect.any(String));
  });

  it("does not resolve a tap on a reply sent to another customer", async () => {
    const { chat, send } = await setup({ replyTo: "14155559999" });

    await send(buttonTap(`rb:${REPLY}:0:1`));

    expect(chat.answer.mock.calls[0][0]).not.toHaveProperty("selection");
  });

  it("does not send a pick when there is no conversation to pick in", async () => {
    const { chat, send } = await setup({ conversation: false });

    await send(buttonTap(`rb:${REPLY}:0:1`));

    expect(chat.answer.mock.calls[0][0]).not.toHaveProperty("selection");
  });

  it("answers a tap sent together with typed text as words, not a pick", async () => {
    const { chat, send } = await setup();

    await send({ type: "text", text: { body: "this one" } }, buttonTap(`rb:${REPLY}:0:1`));

    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(chat.answer.mock.calls[0][0]).toMatchObject({ query: "this one\nScegli" });
    expect(chat.answer.mock.calls[0][0]).not.toHaveProperty("selection");
  });
});
