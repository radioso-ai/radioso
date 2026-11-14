import { randomUUID } from "node:crypto";

import type { RoutineState, RoutineStep, StagedContext, TurnContext } from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../../../src/db/repositories/messageRepository.js";
import type { ChatAnswerPort, ChatGateway } from "../../../../src/modules/chat/contracts/index.js";
import { replyBlocksCapabilityFromRequest } from "../../../../src/modules/chat/contracts/replyBlocks.js";
import { AssistantChatService } from "../../../../src/modules/chat/services/assistantChatService.js";
import { AssistantSuggestionExpansionService } from "../../../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatBootstrapService } from "../../../../src/modules/chat/services/chatBootstrapService.js";
import { ChatAnswerPresenter } from "../../../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatService } from "../../../../src/modules/chat/services/chatService.js";
import type { PreparedSession } from "../../../../src/modules/chat/services/chatSessionPreparer.js";
import { buildChatTurnRuntime } from "../../../../src/modules/chat/services/chatTurnRuntime.js";
import { routineItemSelectionOf, type SelectedItem } from "../../../../src/modules/chat/services/replyBlocks/itemSelection.js";
import { ItemSelectionTurns } from "../../../../src/modules/chat/services/replyBlocks/itemSelectionTurn.js";
import { latestRoutinePresentation } from "../../../../src/modules/chat/services/replyBlocks/routinePresentation.js";
import { ReplyPictureReadiness } from "../../../../src/modules/chat/services/replyBlocks/replyPictureReadiness.js";
import { SkillResultReplyBlocks } from "../../../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "../../../../src/modules/chat/services/routines/routineGroundedAnswerRenderer.js";
import type { AssistantChatRequest } from "../../../../src/modules/chat/types/assistantApi.js";
import { createConnectorChatPort } from "../../../../src/modules/connectors/services/connectorChatPort.js";
import { WhatsAppClient } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappClient.js";
import { WhatsAppMessageHandler } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.js";
import { findInboundMessageInPayload } from "../../../../src/modules/connectors/plugins/whatsapp/whatsappWebhook.js";
import { compileRoutineDefinition } from "../../../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../../../src/modules/routines/domain.js";
import { InMemoryWhatsAppPersistence } from "./support/inMemoryWhatsAppPersistence.js";

// A routine step that shows a skill step's results, on WhatsApp (#1763, US4 and US7): the host
// offers the cards with button labels because WhatsApp declares it draws them; the connector sends
// a carousel; the customer taps a card; the chat door reads the card from the stored reply; the
// engine fills the step's slot; the next step's reply names the card. The chat's own pieces are
// the real ones; the model, the skill call and the stores are stand-ins.

const WORKSPACE = "workspace-1";
const CUSTOMER = "14155551234";
const CONVERSATION = "conversation-1";
const RUN = "run-1";

const HOMES = [
  { id: "h-1", name: "Casa Blu", url: "https://homes.example/casa-blu", photo: "https://img.homes.example/casa-blu.jpg" },
  { id: "h-2", name: "Villa Rosa", url: "https://homes.example/villa-rosa", photo: "https://img.homes.example/villa-rosa.jpg" },
];

const definition: RoutineDefinition = {
  id: "routine-homes",
  agentId: "agent-1",
  lineageId: "lineage-homes",
  name: "find-a-home",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "Find a home.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "area", key: "area", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "chosen_home", key: "chosen_home", type: "item", required: true, description: null, ordinal: 1 },
    { stableSlotId: "email", key: "email", type: "email", required: true, description: null, ordinal: 2 },
  ],
  steps: [
    { stableStepId: "brief", kind: "chat", instruction: "Where? {{slot.area}}", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search.", toolRef: "search_homes", ordinal: 1, metadata: {} },
    { stableStepId: "choose", kind: "chat", instruction: "Show the homes.", toolRef: null, ordinal: 2, metadata: { present: { from: "search", selection: "single", slot: "chosen_home" } } },
    { stableStepId: "contact", kind: "chat", instruction: "You chose {{slot.chosen_home}}. Your email? {{slot.email}}", toolRef: null, ordinal: 3, metadata: {} },
  ],
  transitions: [
    { fromStep: "brief", toRef: "search", guardKind: "default", guardText: null, ordinal: 0 },
    { fromStep: "search", toRef: "choose", guardKind: "default", guardText: null, ordinal: 1 },
    { fromStep: "choose", toRef: "contact", guardKind: "default", guardText: null, ordinal: 2 },
    { fromStep: "contact", toRef: "handoff", guardKind: "default", guardText: null, ordinal: 3 },
  ],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "An agent will call.", ordinal: 0 }],
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
};

const choose: RoutineStep = { id: "choose", kind: "chat", action: "Show the homes.", present: { from: "search", selection: "single", slot: "chosen_home" } };
const searchResult: StagedContext = {
  kind: "skill_result",
  source: "search_homes",
  data: { structuredContent: { results: HOMES } },
  metadata: { stepId: "search", status: "completed" },
};

/** What the model writes on the presenting step: the cards, and the button labels in the customer's language. */
const PRESENTING_REPLY = JSON.stringify({
  present: { records: ["r1", "r2"], fields: { title: "/name", subtitle: null, image: "/photo", link: "/url" }, caption: "Case a Mitte", selectLabel: "Scegli", openLabel: "Apri" },
  answer: "Ecco due case a Mitte: quale preferisci?",
});

/**
 * The conversation's messages and the routine's state, and a chat service that runs a turn on
 * them: the presenting step's reply on a typed message, the routine engine on a pick.
 */
const chatHost = () => {
  const messages: MessageRecord[] = [];
  let state: RoutineState = { sessionId: CONVERSATION, routineId: "routine-homes", executionId: RUN, path: ["brief", "search", "choose"], variables: { area: "Mitte" }, status: "active" };
  const store = (role: "user" | "assistant", content: string, extra: Partial<MessageRecord> = {}): MessageRecord => {
    const record = { id: randomUUID(), conversationId: CONVERSATION, workspaceId: WORKSPACE, role, content, createdAt: new Date(Date.now() + messages.length), ...extra };
    messages.push(record);
    return record;
  };

  const gateway: ChatGateway = {
    async answer() { return PRESENTING_REPLY; },
    async *streamAnswer() { yield PRESENTING_REPLY; },
  };
  const runtime = buildChatTurnRuntime({
    chatGateway: gateway,
    fallbackReplyComposer: { composeNoContext: vi.fn() },
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    skillResultReplyBlocks: new SkillResultReplyBlocks({
      imageUrls: { forImage: (imageId) => ({ src: `https://api.example/api/v1/public/reply-images/${imageId}/640`, srcSet: "" }) },
      newImageId: (() => { let next = 0; return () => `image-${++next}`; })(),
    }),
  });
  const presenter = new ChatAnswerPresenter(new AssistantSuggestionExpansionService());

  /** The presenting step's reply, as the turn renders it for the channel that asked. */
  const presentingTurn = async (input: AssistantChatRequest) => {
    const session = {
      agent: { id: "agent-1", workspaceId: WORKSPACE, name: "Nico", chatModelOverride: null, replyCardsEnabled: true },
      conversation: { id: CONVERSATION, workspaceId: WORKSPACE, sourceChannel: input.sourceChannel },
      userMessage: { id: "message-1", content: input.message },
      effectiveQuery: input.message,
      history: [],
      turnRoute: "retrieval",
      retrieval: { responseIdentity: null, responseSettings: {} },
      resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
      directiveSteering: { rules: [], omissions: [], matches: [] },
      replyBlocks: replyBlocksCapabilityFromRequest(input.clientContextCapabilities?.["reply.blocks"]),
      turnTrace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
    } as unknown as PreparedSession;
    const renderer = createRoutineGroundedAnswerRenderer({
      session,
      turnSkills: runtime.turnSkills,
      presentingSteps: { skillResultRenderer: runtime.skillResultRenderer, metrics: { incrementCounter: vi.fn() } },
      chatAnswerPresenter: runtime.chatAnswerPresenter,
    });
    const turn: TurnContext = {
      agent: { id: "agent-1", name: "Nico" },
      sessionId: CONVERSATION,
      inputEvent: { id: "message-1", kind: "message", content: input.message ?? "" },
      history: [],
      stagedContext: [searchResult],
      steering: [],
      activeRoutineId: "routine-homes",
      activeStepId: "choose",
      activeRoutineExecutionId: RUN,
    };
    const presentation = presentRoutineRenderableAnswer(presenter, await renderer.prepare!({ step: choose, steering: [], turn })!.render());
    const reply = store("assistant", presentation.answer, { metadata: { blocks: presentation.replyBlocks!.stored } });
    return { reply, answer: presentation.answer, blocks: presentation.replyBlocks!.presented };
  };

  /** The routine's turn on a pick, as chat runs it: history and state read, the next state kept. */
  const pickTurn = async (query: string, item: SelectedItem) => {
    const shownItems = latestRoutinePresentation(messages);
    const itemSelection = routineItemSelectionOf(item);
    const runner = new DefaultRoutineRunner(
      [compileRoutineDefinition(definition)],
      { select: async ({ currentStep }) => ({ nextStepId: currentStep.id }) },
      { render: async ({ step }) => ({ answer: step.action ?? "" }) },
    );
    const turn: TurnContext = {
      agent: { id: "agent-1", name: "Nico" },
      sessionId: CONVERSATION,
      inputEvent: { kind: "message", content: query, ...(itemSelection ? { itemSelection } : {}), ...(shownItems ? { shownItems } : {}) },
      history: [],
      stagedContext: [],
      steering: [],
    };
    const result = await runner.resume({ turn, state });
    state = result.nextState ?? state;
    return { reply: store("assistant", result.response.answer), answer: result.response.answer };
  };

  const chatService = {
    answer: vi.fn(async (input: AssistantChatRequest & { query: string; itemSelection?: SelectedItem }) => {
      store("user", input.query, input.inputMetadata ? { inputMetadata: input.inputMetadata } : {});
      const turn = input.itemSelection
        ? await pickTurn(input.query, input.itemSelection)
        : await presentingTurn({ ...input, message: input.query });
      return {
        conversationId: CONVERSATION,
        assistantMessageId: turn.reply.id,
        answer: turn.answer,
        skillOutcome: "routine.step",
        ...("blocks" in turn ? { blocks: turn.blocks } : {}),
      };
    }),
  };
  const door = new AssistantChatService(chatService as unknown as ChatService, {} as ChatBootstrapService, {
    itemSelections: new ItemSelectionTurns({
      conversations: {
        findByIdAndAnonymousSession: async () => null,
        findByIdAndWorkspaceId: async (id) => (id === CONVERSATION ? { id, workspaceId: WORKSPACE, sourceChannel: "whatsapp" } as never : null),
      },
      messages: {
        findByIdAndWorkspaceId: async (_workspaceId, id) => messages.find((message) => message.id === id) ?? null,
        // As the message repository answers it: a stored pick of another card from that reply.
        hasOtherItemSelectionFrom: async ({ messageId, itemKey }) => messages.some((message) =>
          message.inputMetadata?.selection?.messageId === messageId && message.inputMetadata.selection.itemKey !== itemKey),
      },
    }),
  });
  return { chatService, door, messages, state: () => state };
};

/** The Graph API, recording each message the connector sends. */
const recordedGraph = () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.sent.${bodies.length}` }] }), { status: 200 });
  });
  return { bodies, fetch };
};

const webhook = (id: string, message: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: "15550001111" },
    contacts: [{ wa_id: CUSTOMER, profile: { name: "Alicia" } }],
    messages: [{ id, from: CUSTOMER, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
  } }] }],
});

describe("a WhatsApp reply with and without cards", () => {
  const CARDS = {
    messageId: "11111111-1111-4111-8111-111111111111",
    blocks: [{
      type: "item_list" as const,
      id: "b1",
      layout: "carousel" as const,
      selection: "single" as const,
      caption: "Homes",
      items: HOMES.map((home, index) => ({
        key: `/results/${index}`,
        title: home.name,
        image: { src: `https://api.example/api/v1/public/reply-images/img-${index}/640`, alt: "", width: 640, height: 480 },
        actions: [{ type: "select" as const }],
      })),
      buttonLabels: { select: "Scegli" },
    }],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** `unreachableSends`: how many sends fail before Graph is reached at all, as on a network outage. */
  const setup = (answer: Awaited<ReturnType<ChatAnswerPort["answer"]>> | Record<string, unknown>, unreachableSends = 0) => {
    const graph = recordedGraph();
    let sends = 0;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sends += 1;
      return sends <= unreachableSends ? Promise.reject(new TypeError("fetch failed")) : graph.fetch(url, init);
    });
    const persistence = new InMemoryWhatsAppPersistence();
    const chat = { imageAllowance: vi.fn(async () => null), awaitReplyPictures: vi.fn(async () => true), answer: vi.fn(async () => answer as never) };
    const handler = new WhatsAppMessageHandler({
      db: { query: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      chat,
      state: {
        getConfig: async () => ({ enabled: true, config: { phone_number_id: "15550001111", access_token: "wa-access-token", conversation_timeout_hours: "24" } }),
        setErrorStatus: vi.fn(),
      },
      client: new WhatsAppClient({ fetch: fetch, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }),
      persistence,
      debounceMs: 10,
      retryBaseDelayMs: 100,
    });
    const receive = async () => {
      const inbound = findInboundMessageInPayload(WORKSPACE, webhook("wamid-in-1", { type: "text", text: { body: "Homes?" } }), "wamid-in-1")!;
      await persistence.createInboundMessageLog({ wamid: inbound.wamid, workspaceId: WORKSPACE, waId: CUSTOMER, messageType: inbound.type, payload: inbound.payload });
      await handler.handleInboundMessage(inbound);
      await vi.advanceTimersByTimeAsync(10);
    };
    const outbound = () => [...persistence.messageLogs.values()].filter((log) => log.direction === "outbound" && log.wamid.startsWith("local-"));
    return { graph, chat, persistence, receive, outbound };
  };

  it("sends a reply without cards exactly as before: one text message, and the same outbound row", async () => {
    const { graph, receive, outbound } = setup({ conversationId: CONVERSATION, answer: "Two homes fit.", outcome: "answered" });

    await receive();

    expect(graph.bodies).toStrictEqual([{ messaging_product: "whatsapp", to: CUSTOMER, type: "text", text: { body: "Two homes fit." } }]);
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0]?.messageType).toBe("text");
    expect(outbound()[0]?.payload).toStrictEqual({ text: "Two homes fit.", inbound_wamids: ["wamid-in-1"] });
  });

  it("keeps a reply's cards on its outbound row, and sends the same cards again, with no new turn, when nothing of the reply went", async () => {
    // Graph cannot be reached when the carousel goes: nothing of the reply went, so it is retried whole, with no list.
    const { graph, chat, receive, outbound } = setup({ conversationId: CONVERSATION, answer: "Two homes fit.", outcome: "answered", replyBlocks: CARDS }, 1);

    await receive();
    await vi.advanceTimersByTimeAsync(200);

    expect(chat.answer).toHaveBeenCalledTimes(1);
    expect(outbound()).toHaveLength(1);
    expect(outbound()[0]).toMatchObject({ messageType: "interactive", status: "replied", payload: { text: "Two homes fit.", reply_cards: CARDS } });
    expect(graph.bodies).toHaveLength(1);
    expect(graph.bodies[0]).toMatchObject({ type: "interactive", interactive: { type: "carousel", body: { text: "Two homes fit." } } });
  });
});

describe("a routine's cards on WhatsApp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The WhatsApp connector over the real chat port, the chat door and the picture check, against the host above. */
  const whatsAppOn = (host: ReturnType<typeof chatHost>) => {
    const graph = recordedGraph();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const persistence = new InMemoryWhatsAppPersistence();
    const stored = { findServable: vi.fn(async (_input: { imageId: string; width: number }) => ({ bucket: "b", objectPath: "p" })) };
    const handler = new WhatsAppMessageHandler({
      db: { query: vi.fn() },
      logger,
      chat: createConnectorChatPort(host.chatService as unknown as ChatAnswerPort, { ingest: vi.fn() }, {
        picks: host.door,
        replyPictures: new ReplyPictureReadiness({
          messages: { findByIdAndWorkspaceId: async (_workspaceId, id) => host.messages.find((message) => message.id === id) ?? null },
          pictures: stored,
          width: 640,
        }),
      }),
      state: {
        getConfig: async () => ({ enabled: true, config: { phone_number_id: "15550001111", access_token: "wa-access-token", conversation_timeout_hours: "24" } }),
        setErrorStatus: vi.fn(),
      },
      client: new WhatsAppClient({ fetch: graph.fetch, logger }),
      persistence,
      debounceMs: 10,
    });
    const receive = async (id: string, message: Record<string, unknown>) => {
      const inbound = findInboundMessageInPayload(WORKSPACE, webhook(id, message), id)!;
      await persistence.createInboundMessageLog({ wamid: id, workspaceId: WORKSPACE, waId: CUSTOMER, messageType: inbound.type, payload: inbound.payload });
      await handler.handleInboundMessage(inbound);
      await vi.advanceTimersByTimeAsync(10);
    };
    type Carousel = {
      type: string;
      body: { text: string };
      action: { cards: Array<{ body: { text: string }; header: { image: { link: string } }; action: { buttons: Array<{ quick_reply: { id: string; title: string } }> } }> };
    };
    const carousel = () => graph.bodies.find((body) => body.type === "interactive")?.interactive as Carousel;
    const tap = (card: number) => ({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: carousel().action.cards[card].action.buttons[0].quick_reply.id, title: "Scegli" } } });
    return { graph, persistence, stored, receive, carousel, tap };
  };

  it("sends the presenting step as a carousel, and a tap fills the step's slot and the next step names the card", async () => {
    const host = chatHost();
    const { graph, stored, receive, carousel, tap } = whatsAppOn(host);

    await receive("wamid-in-1", { type: "text", text: { body: "Mitte, fino a 2.000" } });

    expect(stored.findServable.mock.calls.map(([input]) => input)).toEqual([{ imageId: "image-1", width: 640 }, { imageId: "image-2", width: 640 }]);
    expect(carousel().type).toBe("carousel");
    expect(carousel().body.text).toBe("Ecco due case a Mitte: quale preferisci?");
    expect(carousel().action.cards.map((card) => card.body.text)).toEqual(["Casa Blu", "Villa Rosa"]);
    expect(carousel().action.cards.map((card) => card.action.buttons[0].quick_reply.title)).toEqual(["Scegli", "Scegli"]);
    expect(carousel().action.cards[0].header.image.link).toBe("https://api.example/api/v1/public/reply-images/image-1/640");

    await vi.advanceTimersByTimeAsync(60_000);
    await receive("wamid-in-2", tap(1));

    expect(host.state().variables.chosen_home).toEqual({ key: "/structuredContent/results/1", title: "Villa Rosa", link: "https://homes.example/villa-rosa", fields: { id: "h-2", name: "Villa Rosa", url: "https://homes.example/villa-rosa", photo: "https://img.homes.example/villa-rosa.jpg" } });
    expect(host.state().path.at(-1)).toBe("contact");
    expect(graph.bodies[1]).toEqual({ messaging_product: "whatsapp", to: CUSTOMER, type: "text", text: { body: "You chose Villa Rosa. Your email? " } });
    // The pick is the visitor's message, stored as the web chat stores one: the card's words and the ids it named.
    expect(host.messages.find((message) => message.inputMetadata?.method === "item_select")).toMatchObject({
      content: "Villa Rosa",
      inputMetadata: { method: "item_select", selection: { blockId: "b1", itemKey: "/structuredContent/results/1" } },
    });
  });

  it("runs no turn on a tap of the other card once the routine has moved on to a step that asks for text, so no slot is filled from it", async () => {
    const host = chatHost();
    const { graph, persistence, receive, tap } = whatsAppOn(host);
    await receive("wamid-in-1", { type: "text", text: { body: "Mitte, fino a 2.000" } });
    await vi.advanceTimersByTimeAsync(60_000);
    await receive("wamid-in-2", tap(1));
    const before = structuredClone(host.state());
    const turns = host.chatService.answer.mock.calls.length;
    const sent = graph.bodies.length;

    await vi.advanceTimersByTimeAsync(60_000);
    await receive("wamid-in-3", tap(0));

    expect(host.chatService.answer).toHaveBeenCalledTimes(turns);
    expect(host.state()).toEqual(before);
    expect(host.state().path.at(-1)).toBe("contact");
    expect(host.messages.filter((message) => message.content === "Casa Blu")).toEqual([]);
    expect(graph.bodies).toHaveLength(sent);
    expect(persistence.messageLogs.get("wamid-in-3")?.status).toBe("skipped");
  });
});
