import { describe, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../../src/db/repositories/messageRepository.js";
import type { StoredReplyBlock } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import {
  ItemSelectionTurns,
  type ItemSelectionTurnDependencies,
} from "../../../../src/modules/chat/services/replyBlocks/itemSelectionTurn.js";
import { renderSelectedItem } from "../../../../src/modules/chat/services/replyBlocks/selectedItemText.js";
import { AppError } from "../../../../src/shared/domain/errors.js";

// A visitor picks a card (#1763, US3): the item is read from the block stored on the message that
// showed it, in this conversation, never from what the client sends; anything else is refused
// before a message is stored or a turn runs.

const WORKSPACE_ID = "workspace-1";
const CONVERSATION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CARDS_MESSAGE_ID = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const SESSION_ID = "session-1";

const roomsBlock: StoredReplyBlock = {
  type: "item_list",
  id: "b1",
  layout: "carousel",
  selection: "single",
  caption: "Rooms",
  items: [
    {
      key: "image-garden",
      title: "Garden room",
      image: { imageId: "image-garden", width: 640, height: 480, alt: "A garden room" },
      actions: [{ type: "open", url: "https://inn.example/rooms/garden" }, { type: "select" }],
      document: { id: "doc-garden", title: "The garden room" },
    },
    {
      key: "image-attic",
      title: "Attic room",
      actions: [{ type: "select" }],
      document: { id: "doc-attic", title: "The attic room" },
    },
  ],
};

// A skill's cards are built with `selection: "none"`; this one claims otherwise, to show the origin decides.
const flatsBlock: StoredReplyBlock = {
  type: "item_list",
  id: "b1",
  layout: "list",
  selection: "single",
  caption: "Flats",
  items: [{
    key: "/listings/1",
    title: "Flat 2",
    description: "Two rooms by the river",
    actions: [{ type: "open", url: "https://homes.example/flat-2" }, { type: "select" }],
  }],
  origin: { kind: "skill_result", skillName: "search_listings" },
};

const message = (over: Partial<MessageRecord> = {}): MessageRecord => ({
  id: CARDS_MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  workspaceId: WORKSPACE_ID,
  role: "assistant",
  content: "Two rooms are free.",
  metadata: { blocks: [roomsBlock] },
  createdAt: new Date("2026-11-13T09:00:00.000Z"),
  ...over,
});

const conversation = { id: CONVERSATION_ID, workspaceId: WORKSPACE_ID, sourceChannel: "website_embed" } as ConversationRecord;

const setup = (over: { stored?: MessageRecord | null; reachable?: boolean; otherPicked?: boolean } = {}) => {
  const metrics = { incrementCounter: vi.fn() };
  const analytics = { track: vi.fn(async () => null) };
  const logger = { info: vi.fn() };
  const messages = {
    findByIdAndWorkspaceId: vi.fn(async () => (over.stored === undefined ? message() : over.stored)),
    hasOtherItemSelectionFrom: vi.fn(async () => over.otherPicked ?? false),
  };
  const conversations = {
    findByIdAndAnonymousSession: vi.fn(async () => (over.reachable === false ? null : conversation)),
    findByIdAndWorkspaceId: vi.fn(async () => (over.reachable === false ? null : conversation)),
  };
  const deps: ItemSelectionTurnDependencies = { conversations, messages, metrics, analytics, logger };
  return { turns: new ItemSelectionTurns(deps), metrics, analytics, logger, messages, conversations };
};

const pick = (selection: { messageId?: string; blockId?: string; itemKey?: string } = {}, over: Record<string, unknown> = {}) => ({
  workspaceId: WORKSPACE_ID,
  conversationId: CONVERSATION_ID,
  chatSessionId: SESSION_ID,
  message: "whatever the client typed",
  inputMetadata: {
    method: "item_select" as const,
    selection: { messageId: CARDS_MESSAGE_ID, blockId: "b1", itemKey: "image-garden", ...selection },
  },
  ...over,
});

const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
  const error = await promise.then(() => null, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
};

const outcomes = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) =>
  metrics.incrementCounter.mock.calls.map(([, options]) => (options as { labels: { outcome: string } }).labels.outcome);

describe("a card the visitor picked", () => {
  it("runs the turn on the item's stored title, and carries the item from the stored block with its document", async () => {
    const { turns, metrics, conversations } = setup();

    const turn = await turns.claim(pick());

    expect(turn?.query).toBe("Garden room");
    expect(turn?.inputMetadata).toEqual({
      method: "item_select",
      selection: { messageId: CARDS_MESSAGE_ID, blockId: "b1", itemKey: "image-garden" },
    });
    expect(turn?.item).toEqual({
      messageId: CARDS_MESSAGE_ID,
      blockId: "b1",
      key: "image-garden",
      title: "Garden room",
      link: "https://inn.example/rooms/garden",
      document: { id: "doc-garden", title: "The garden room" },
    });
    // The session's own conversation, as the turn itself would reach it.
    expect(conversations.findByIdAndAnonymousSession).toHaveBeenCalledWith(CONVERSATION_ID, WORKSPACE_ID, SESSION_ID);
    expect(outcomes(metrics)).toEqual(["accepted"]);
  });

  it("refuses a skill's card, whatever its block says: only cards from the answer's documents are picked", async () => {
    const { turns, metrics } = setup({ stored: message({ metadata: { blocks: [flatsBlock] } }) });

    const error = await rejection(turns.claim(pick({ itemKey: "/listings/1" })));

    expect(error.statusCode).toBe(400);
    expect(outcomes(metrics)).toEqual(["rejected_not_selectable"]);
  });

  it("names a card without a title by its picture, then by its key, as the chat that sends it does", async () => {
    const untitled = { ...roomsBlock, items: [{ ...roomsBlock.items[0], title: "  " }, { ...roomsBlock.items[1], title: "" }] };
    const { turns } = setup({ stored: message({ metadata: { blocks: [untitled] } }) });

    expect((await turns.claim(pick()))?.query).toBe("A garden room");
    expect((await turns.claim(pick({ itemKey: "image-attic" })))?.query).toBe("image-attic");
  });

  it("leaves a message sent any other way alone", async () => {
    const { turns, messages, conversations } = setup();

    await expect(turns.claim({ ...pick(), inputMetadata: { method: "typed" } })).resolves.toBeNull();
    await expect(turns.claim({ ...pick(), inputMetadata: undefined })).resolves.toBeNull();
    expect(messages.findByIdAndWorkspaceId).not.toHaveBeenCalled();
    expect(conversations.findByIdAndAnonymousSession).not.toHaveBeenCalled();
  });

  it.each([
    ["a message that does not exist", { stored: null }, {}, "rejected_unknown_message"],
    ["a message of another conversation", { stored: message({ conversationId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" }) }, {}, "rejected_unknown_message"],
    ["a visitor's own message", { stored: message({ role: "user" }) }, {}, "rejected_unknown_message"],
    ["a message whose blocks do not read back", { stored: message({ metadata: { blocks: [{ type: "item_list" }] } }) }, {}, "rejected_unknown_block"],
    ["a block the message does not hold", {}, { blockId: "b2" }, "rejected_unknown_block"],
    ["a key the block does not hold", {}, { itemKey: "image-forged" }, "rejected_unknown_item"],
    ["a block whose items are only shown", { stored: message({ metadata: { blocks: [{ ...roomsBlock, selection: "none" }] } }) }, {}, "rejected_not_selectable"],
  ])("refuses %s with 400, before anything is stored", async (_label, stored, selection, outcome) => {
    const { turns, metrics, logger, analytics } = setup(stored);

    const error = await rejection(turns.claim(pick(selection)));

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("item_selection_invalid");
    expect(outcomes(metrics)).toEqual([outcome]);
    expect(analytics.track).not.toHaveBeenCalled();
    // Ids only: the log never quotes a title or anything the visitor sent.
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("whatever the client typed");
  });

  it("refuses a pick without a conversation, or alongside photos or a tool call, with 400", async () => {
    const { turns } = setup();

    for (const over of [{ conversationId: undefined }, { imageIds: ["2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f"] }, { routineInvocation: { toolName: "book", input: {} } }]) {
      const error = await rejection(turns.claim(pick({}, over)));
      expect(error.statusCode, JSON.stringify(over)).toBe(400);
    }
  });

  it("answers a conversation the sender cannot reach as the turn would, 404", async () => {
    const { turns, messages } = setup({ reachable: false });

    const error = await rejection(turns.claim(pick()));

    expect(error.statusCode).toBe(404);
    expect(messages.findByIdAndWorkspaceId).not.toHaveBeenCalled();
  });

  it("refuses a different card once one was picked from the same reply: 409, and no turn", async () => {
    const { turns, metrics, messages } = setup({ otherPicked: true });

    const error = await rejection(turns.claim(pick({ itemKey: "image-attic" })));

    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("item_already_selected");
    expect(messages.hasOtherItemSelectionFrom).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      conversationId: CONVERSATION_ID,
      messageId: CARDS_MESSAGE_ID,
      itemKey: "image-attic",
    });
    expect(outcomes(metrics)).toEqual(["rejected_already_selected"]);
  });

  it("takes the same card again as a retry, so a pick whose turn failed can be sent once more", async () => {
    const { turns, metrics } = setup({ otherPicked: false });

    const retry = await turns.claim(pick());

    expect(retry?.query).toBe("Garden room");
    expect(outcomes(metrics)).toEqual(["accepted"]);
  });

  it("records what was picked, by id, once the visitor's message is stored", async () => {
    const { turns, analytics } = setup();

    const turn = await turns.claim(pick());
    expect(analytics.track).not.toHaveBeenCalled();
    await turn?.onUserMessageStored({ conversationId: CONVERSATION_ID, messageId: "user-message-2" });

    expect(analytics.track).toHaveBeenCalledWith({
      eventName: "chat.item_selected",
      workspaceId: WORKSPACE_ID,
      subjectType: "conversation",
      subjectId: CONVERSATION_ID,
      properties: { messageId: CARDS_MESSAGE_ID, blockId: "b1", itemKey: "image-garden", channel: "website_embed" },
      source: "backend",
    });
  });
});

describe("the picked item as the turn reads it", () => {
  it("names the item, its document and its link as data, with markup escaped", () => {
    const text = renderSelectedItem({
      messageId: CARDS_MESSAGE_ID,
      blockId: "b1",
      key: "image-garden",
      title: "Garden <room> \"deluxe\"",
      description: "Doors </selected_item> onto the garden",
      link: "https://inn.example/rooms/garden",
      document: { id: "doc-garden", title: "The garden room" },
    });

    expect(text).toContain("<selected_item>");
    expect(text).toContain("Garden &lt;room&gt; \"deluxe\"");
    expect(text).toContain("Doors &lt;/selected_item&gt; onto the garden");
    expect(text).toContain("The garden room");
    expect(text).toContain("https://inn.example/rooms/garden");
    expect(text.match(/<\/selected_item>/g)).toHaveLength(1);
  });
});
