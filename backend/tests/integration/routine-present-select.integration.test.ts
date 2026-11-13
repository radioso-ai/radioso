import { randomUUID } from "node:crypto";

import type {
  ConversationRoutineConsentPort,
  ConversationRoutineNextStepSelector,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import { MessageRepository } from "../../src/db/repositories/messageRepository.js";
import { RoutineStateRepository } from "../../src/db/repositories/routineStateRepository.js";
import type { StoredReplyBlock } from "../../src/modules/chat/contracts/replyBlocks.js";
import { routineItemSelectionOf } from "../../src/modules/chat/services/replyBlocks/itemSelection.js";
import { ItemSelectionTurns } from "../../src/modules/chat/services/replyBlocks/itemSelectionTurn.js";
import { latestRoutinePresentation } from "../../src/modules/chat/services/replyBlocks/routinePresentation.js";
import { compileRoutineDefinition } from "../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../src/modules/routines/domain.js";
import { Database } from "../../src/shared/infra/database.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

// A visitor's pick of a routine step's card (#1763, US7) through the host and the engine, against
// Postgres: the reply's stored block and the pick message are rows, the routine's state is a row,
// and the pick fills the step's slot only from the step's latest presentation in the current run,
// on the step the run waits on, past no consent that holds the slot back.

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

/** Two runs of the routine: the one waiting on the step, and an earlier one. */
const RUN_1 = randomUUID();
const RUN_2 = randomUUID();

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinition["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, ordinal });

const definition = (options: { sensitive?: boolean } = {}): RoutineDefinition => ({
  id: "routine-homes",
  agentId: "agent-1",
  lineageId: "lineage-homes",
  name: "find-a-home",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "Find a home.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "area", key: "area", type: "text", required: true, description: null, ordinal: 0 },
    { stableSlotId: "chosen_home", key: "chosen_home", type: "item", required: true, description: null, ordinal: 1, ...(options.sensitive ? { sensitivity: "sensitive" as const } : {}) },
    { stableSlotId: "email", key: "email", type: "email", required: true, description: null, ordinal: 2 },
  ],
  steps: [
    { stableStepId: "brief", kind: "chat", instruction: "Where? {{slot.area}}", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search.", toolRef: "search_homes", ordinal: 1, metadata: {} },
    { stableStepId: "choose", kind: "chat", instruction: "Show the homes.", toolRef: null, ordinal: 2, metadata: { present: { from: "search", selection: "single", slot: "chosen_home" } } },
    { stableStepId: "contact", kind: "chat", instruction: "You chose {{slot.chosen_home}}. Your email? {{slot.email}}", toolRef: null, ordinal: 3, metadata: {} },
  ],
  transitions: [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "contact", 2), edge("contact", "handoff", 3)],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "An agent will call.", ordinal: 0 }],
  ...(options.sensitive ? { consents: [{ key: "home", slotKeys: ["chosen_home"], onDecline: "continue" as const, variants: [] }] } : {}),
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
});

describeIntegration("routine card picks (Postgres)", () => {
  const database = new Database(integrationDatabaseUrl);
  const messages = new MessageRepository(database.kysely);
  const states = new RoutineStateRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const conversationId = randomUUID();
  const conversation = { id: conversationId, workspaceId, sourceChannel: "website_embed" } as ConversationRecord;

  const homes = (executionId: string, titles: readonly string[]): StoredReplyBlock => ({
    type: "item_list",
    id: "b1",
    layout: "list",
    selection: "single",
    caption: "Homes in Mitte",
    items: titles.map((title, index) => ({
      key: `/results/${index}`,
      title,
      actions: [{ type: "open", url: `https://homes.example/listing-${index}` }, { type: "select" }],
      fields: { id: `h-${index}`, rooms: index + 1 },
    })),
    origin: { kind: "routine_step", skillName: "search_homes", routineId: "routine-homes", stepId: "choose", executionId, slot: "chosen_home" },
  });

  beforeAll(async () => {
    await database.query(`INSERT INTO accounts (id, name, email, password_hash) VALUES ($1,$2,$3,$4)`, [accountId, "Homes Co", `acct-${accountId}@example.com`, "hash"]);
    await database.query(`INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1,$2,$3,$4)`, [workspaceId, accountId, "Homes", `route-${workspaceId}`]);
    await database.query(`INSERT INTO conversations (id, workspace_id) VALUES ($1,$2)`, [conversationId, workspaceId]);
  });

  beforeEach(async () => {
    await database.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversationId]);
    await states.clear({ sessionId: conversationId });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM accounts WHERE id = $1`, [accountId]).catch(() => undefined);
    await database.close().catch(() => undefined);
  });

  /** A reply that showed cards, aged so the order of two replies never rests on equal timestamps. */
  const cardsReply = async (block: StoredReplyBlock, minutesAgo: number) => {
    const reply = await messages.create({ conversationId, workspaceId, role: "assistant", content: "Homes that fit.", metadata: { blocks: [block] } });
    await database.query(`UPDATE messages SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [reply.id, minutesAgo]);
    return reply;
  };

  /** The visitor's tap, as the chat turns it into a turn: claimed against the stored reply, then stored. */
  const tap = async (messageId: string, itemKey: string) => {
    const turns = new ItemSelectionTurns({
      conversations: { findByIdAndAnonymousSession: async () => conversation, findByIdAndWorkspaceId: async () => conversation },
      messages,
    });
    const claimed = await turns.claim({
      workspaceId,
      conversationId,
      chatSessionId: "session-1",
      inputMetadata: { method: "item_select", selection: { messageId, blockId: "b1", itemKey } },
    });
    await messages.create({ conversationId, workspaceId, role: "user", content: claimed!.query, inputMetadata: claimed!.inputMetadata });
    return claimed!;
  };

  /** One routine turn as the chat runs it: history and state read from Postgres, the next state saved back. */
  const runTurn = async (input: {
    item?: Awaited<ReturnType<typeof tap>>["item"];
    content: string;
    selector?: ConversationRoutineNextStepSelector;
    consent?: ConversationRoutineConsentPort;
    sensitive?: boolean;
  }) => {
    const history = await messages.listRecentByConversationId(workspaceId, conversationId, 20);
    const shownItems = latestRoutinePresentation(history);
    const itemSelection = routineItemSelectionOf(input.item);
    const turn: TurnContext = {
      agent: { id: "agent-1", name: "Nico" },
      sessionId: conversationId,
      inputEvent: { kind: "message", content: input.content, ...(itemSelection ? { itemSelection } : {}), ...(shownItems ? { shownItems } : {}) },
      history: [],
      stagedContext: [],
      steering: [],
    };
    const onItemPick = vi.fn();
    const selector = input.selector ?? { select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id })) };
    const runner = new DefaultRoutineRunner(
      [compileRoutineDefinition(definition({ sensitive: input.sensitive }))],
      selector,
      { render: async ({ step }) => ({ answer: `[${step.id}]` }) },
      undefined,
      { onItemPick, ...(input.consent ? { consent: input.consent } : {}) },
    );
    const state = (await states.loadActive({ sessionId: conversationId }))!;
    const result = await runner.resume({ turn, state });
    if (result.nextState) {
      await states.save(result.nextState);
    }
    return { onItemPick, saved: await states.loadActive({ sessionId: conversationId }), selector };
  };

  const waitingOn = async (step: string, executionId: string, variables: Record<string, unknown> = { area: "Mitte" }) => {
    const path = ["brief", "search", "choose", ...(step === "contact" ? ["contact"] : [])];
    const state: RoutineState = { sessionId: conversationId, routineId: "routine-homes", executionId, path, variables, status: "active" };
    await states.save(state);
  };

  it("fills the step's slot with the stored card, link and fields, and the run moves on", async () => {
    const reply = await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 1);
    await waitingOn("choose", RUN_1);

    const picked = await tap(reply.id, "/results/1");
    const { saved, onItemPick } = await runTurn({ item: picked.item, content: picked.query });

    expect(saved?.path.at(-1)).toBe("contact");
    expect(saved?.variables.chosen_home).toEqual({ key: "/results/1", title: "Villa Rosa", link: "https://homes.example/listing-1", fields: { id: "h-1", rooms: 2 } });
    expect(onItemPick).toHaveBeenCalledWith({ routineId: "routine-homes", stepId: "choose", outcome: "applied" });
  });

  it("resolves a typed answer to the card it names, from the stored reply", async () => {
    await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 1);
    await waitingOn("choose", RUN_1);
    await messages.create({ conversationId, workspaceId, role: "user", content: "the second one", inputMetadata: { method: "typed" } });

    const selector = { select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id, variables: { chosen_home: 2 } })) };
    const { saved } = await runTurn({ content: "the second one", selector });

    expect(saved?.variables.chosen_home).toEqual(expect.objectContaining({ key: "/results/1", title: "Villa Rosa", link: "https://homes.example/listing-1" }));
  });

  it("fills nothing from an older presentation, after the step showed cards again", async () => {
    const older = await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 5);
    await cardsReply(homes(RUN_1, ["Loft Nord", "Atelier Ost"]), 1);
    await waitingOn("choose", RUN_1);

    const picked = await tap(older.id, "/results/1");
    const { saved, onItemPick } = await runTurn({ item: picked.item, content: picked.query });

    expect(saved?.variables.chosen_home).toBeUndefined();
    expect(saved?.path.at(-1)).toBe("choose");
    expect(onItemPick).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ignored", reason: "not_latest" }));
  });

  it("fills nothing from a card an earlier run of the routine showed", async () => {
    const reply = await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 1);
    await waitingOn("choose", RUN_2);

    const picked = await tap(reply.id, "/results/1");
    const { saved, onItemPick } = await runTurn({ item: picked.item, content: picked.query });

    expect(saved?.variables.chosen_home).toBeUndefined();
    expect(onItemPick).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ignored", reason: "other_routine" }));
  });

  it("changes no slot on a tap of an old card once the run has moved past the step", async () => {
    const reply = await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 1);
    const casa = { key: "/results/0", title: "Casa Blu", link: "https://homes.example/listing-0", fields: { id: "h-0", rooms: 1 } };
    await waitingOn("contact", RUN_1, { area: "Mitte", chosen_home: casa });

    const picked = await tap(reply.id, "/results/1");
    const selector = { select: vi.fn(async ({ currentStep }) => ({ nextStepId: currentStep.id, variables: { email: "villa@mail.example", area: "Kreuzberg" } })) };
    const { saved, onItemPick } = await runTurn({ item: picked.item, content: picked.query, selector });

    expect(saved?.variables).toEqual({ area: "Mitte", chosen_home: casa });
    expect(saved?.path.at(-1)).toBe("contact");
    expect(onItemPick).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ignored", reason: "other_step" }));
  });

  it("fills nothing when a consent the visitor declined holds the slot back", async () => {
    const reply = await cardsReply(homes(RUN_1, ["Casa Blu", "Villa Rosa"]), 1);
    await waitingOn("choose", RUN_1);
    const consent: ConversationRoutineConsentPort = {
      standing: async () => ({ asks: true, decisions: { home: "declined" } }),
      read: async () => null,
      prompt: async () => null,
    };

    const picked = await tap(reply.id, "/results/1");
    const { saved, onItemPick } = await runTurn({ item: picked.item, content: picked.query, consent, sensitive: true });

    expect(saved?.variables.chosen_home).toBeUndefined();
    expect(onItemPick).toHaveBeenCalledWith(expect.objectContaining({ outcome: "ignored", reason: "consent" }));
  });
});
