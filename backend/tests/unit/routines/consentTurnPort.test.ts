import { describe, expect, it, vi } from "vitest";

import type { RoutineConsentReading, TurnContext } from "@radioso/conversation-contract";

import {
  createRoutineConsentTurnPort,
  type RoutineConsentStore,
  type RoutineConsentTurnFacts,
} from "../../../src/modules/routines/consent/consentTurnPort.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../../src/modules/routines/public.js";
import { routineConsentWordingVersionId } from "../../../src/shared/domain/routineConsentWording.js";

const english = { locale: "en", body: "We use your health details only to plan your class.", agreeLabel: "I agree", declineLabel: "No thanks" };
const italian = { locale: "it", body: "Usiamo i tuoi dati sanitari solo per organizzare la lezione.", agreeLabel: "Acconsento", declineLabel: "No grazie" };
const portuguese = { locale: "pt-PT", body: "Usamos os seus dados de saúde só para planear a aula.", agreeLabel: "Concordo", declineLabel: "Não, obrigado" };

const definition = (variants = [english, italian, portuguese]): RoutineDefinition => ({
  id: "def_class",
  agentId: "agent_1",
  lineageId: "def_class",
  name: "class",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_injury", key: "injury", type: "text", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
  steps: [{ stableStepId: "ask_injury", kind: "chat", instruction: "Ask about {{slot.injury}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_injury", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Thank the visitor.", ordinal: 0 }],
  consents: [{ key: "health", slotKeys: ["injury"], variants, onDecline: "continue" }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
});

const routine = compileRoutineDefinition(definition());
const consent = routine.consents![0];

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "conversation_1",
  inputEvent: { id: "message_2", kind: "message", content },
  history: [],
  stagedContext: [],
  steering: [],
});

const facts = (overrides: Partial<RoutineConsentTurnFacts> = {}): RoutineConsentTurnFacts => ({
  conversationId: "conversation_1",
  visitorId: "visitor_1",
  sourceChannel: "website_embed",
  userMessage: { id: "message_2", inputMetadata: { method: "typed" } },
  preferredLocales: async () => [],
  agentDefaultLocale: "en",
  durable: true,
  ...overrides,
});

const store = (overrides: Partial<RoutineConsentStore> = {}): RoutineConsentStore => ({
  standing: vi.fn(async () => null),
  latestPrompt: vi.fn(async () => null),
  ...overrides,
});

const replies = (reading: RoutineConsentReading = "unclear", answer = "We only use it to plan your class.") => ({
  reader: { read: vi.fn(async () => reading) },
  answerer: { answer: vi.fn(async () => answer) },
});

const port = (input: { facts?: RoutineConsentTurnFacts; store?: RoutineConsentStore; replies?: ReturnType<typeof replies> } = {}) => {
  const usedReplies = input.replies ?? replies();
  return createRoutineConsentTurnPort({
    facts: input.facts ?? facts(),
    store: input.store ?? store(),
    reader: usedReplies.reader,
    answerer: usedReplies.answerer,
  });
};

const shown = async (consentPort: ReturnType<typeof port>, reask = false) => {
  const prompt = await consentPort.prompt({ routine, consent, turn: turn("hello"), reask });
  return prompt ? { wording: prompt.wording, reply: await prompt.reply.render() } : null;
};

describe("the consent a conversation is asked (#1544)", () => {
  it("shows the wording of the language the turn answers in, falling back to its base language and then the agent's", async () => {
    const inItalian = await shown(port({ facts: facts({ preferredLocales: async () => ["it-IT"] }) }));
    expect(inItalian?.wording).toEqual(italian);

    // A regional sibling is never a fallback: Brazilian Portuguese gets the agent's default.
    const inBrazilian = await shown(port({ facts: facts({ preferredLocales: async () => ["pt-BR"] }) }));
    expect(inBrazilian?.wording).toEqual(english);

    // A later preference wins over the default when an earlier one has no wording.
    const secondChoice = await shown(port({ facts: facts({ preferredLocales: async () => ["fr", "it"] }) }));
    expect(secondChoice?.wording).toEqual(italian);

    expect((await shown(port()))?.wording).toEqual(english);
  });

  it("shows nothing when neither the visitor's language nor the agent's has wording", async () => {
    const consentPort = port({ facts: facts({ preferredLocales: async () => ["fr"], agentDefaultLocale: "de" }) });

    expect(await consentPort.prompt({ routine, consent, turn: turn("hello"), reask: false })).toBeNull();
  });

  it("offers the two choices as buttons on the web, around wording sent exactly as written", async () => {
    const asked = await shown(port());

    expect(asked?.reply.answer).toBe(english.body);
    expect(asked?.reply.suggestions).toEqual([
      { id: "agree", text: "I agree", kind: "authored", action: { kind: "ask_followup" } },
      { id: "decline", text: "No thanks", kind: "authored", action: { kind: "ask_followup" } },
    ]);
  });

  it.each(["email", "whatsapp", "slack"])("writes the two choices under the wording on %s, which has no buttons", async (sourceChannel) => {
    const asked = await shown(port({ facts: facts({ sourceChannel }) }));

    expect(asked?.reply.answer).toBe(`${english.body}\n\nI agree\nNo thanks`);
    expect(asked?.reply.suggestions).toBeUndefined();
  });

  it("answers an unclear reply from the wording before showing it again, and asks the first time with the wording alone", async () => {
    const usedReplies = replies();
    const consentPort = port({ facts: facts({ sourceChannel: "email" }), replies: usedReplies });

    expect((await shown(consentPort))?.reply.answer).toBe(`${english.body}\n\nI agree\nNo thanks`);
    expect(usedReplies.answerer.answer).not.toHaveBeenCalled();

    const again = await shown(consentPort, true);
    expect(again?.reply.answer).toBe(`We only use it to plan your class.\n\n${english.body}\n\nI agree\nNo thanks`);
    expect(usedReplies.answerer.answer).toHaveBeenCalledWith({ turn: expect.objectContaining({ inputEvent: expect.objectContaining({ content: "hello" }) }), wording: english });
  });

  it("asks on the web, email, WhatsApp and Slack, and never on voice or of a calling agent", async () => {
    for (const sourceChannel of ["website_embed", "email", "whatsapp", "slack", null]) {
      expect((await port({ facts: facts({ sourceChannel }) }).standing({ routine, turn: turn("hi") })).asks).toBe(true);
    }
    for (const sourceChannel of ["voice", "mcp", "agent_api", "a2a"]) {
      expect((await port({ facts: facts({ sourceChannel }) }).standing({ routine, turn: turn("hi") })).asks).toBe(false);
    }
  });
});

describe("what a conversation already decided (#1544)", () => {
  it("reuses a decision made on any language of the consent, so a language switch is not new wording", async () => {
    const decisions = store({ standing: vi.fn(async () => "granted" as const) });

    const standing = await port({ store: decisions }).standing({ routine, turn: turn("hi") });

    expect(standing.decisions).toEqual({ health: "granted" });
    expect(decisions.standing).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      routineId: routine.id,
      consentKey: "health",
      versionIds: [english, italian, portuguese].map(routineConsentWordingVersionId),
    });
  });

  it("holds no decision for a consent the conversation never decided", async () => {
    expect((await port().standing({ routine, turn: turn("hi") })).decisions).toEqual({});
  });

  it("reads nothing back for a conversation no row is kept for, such as a replay", async () => {
    const untouched = store();

    const standing = await port({ facts: facts({ durable: false }), store: untouched }).standing({ routine, turn: turn("hi") });

    expect(standing).toEqual({ asks: true, decisions: {} });
    expect(untouched.standing).not.toHaveBeenCalled();
  });
});

describe("a visitor's reply to the consent shown (#1544)", () => {
  it("reads a typed reply against the wording the conversation last showed, as a reply", async () => {
    const usedReplies = replies("granted");
    const lastShown = store({
      latestPrompt: vi.fn(async () => ({ messageId: "message_1", wordingVersionId: routineConsentWordingVersionId(italian), locale: "it" })),
    });

    const read = await port({ store: lastShown, replies: usedReplies }).read({ routine, consent, turn: turn("sì, va bene") });

    expect(read).toEqual({ decision: "granted", method: "reply", wording: italian });
    expect(usedReplies.reader.read).toHaveBeenCalledWith({ turn: expect.objectContaining({ inputEvent: expect.objectContaining({ content: "sì, va bene" }) }), wording: italian });
    expect(lastShown.latestPrompt).toHaveBeenCalledWith({ conversationId: "conversation_1", routineId: routine.id, consentKey: "health" });
  });

  it("cannot tell what a reply answers when the conversation shows no prompt, or one with wording the routine no longer carries", async () => {
    const usedReplies = replies("granted");
    expect(await port({ replies: usedReplies }).read({ routine, consent, turn: turn("yes") })).toBeNull();

    const edited = store({ latestPrompt: vi.fn(async () => ({ messageId: "message_1", wordingVersionId: "an-older-wording", locale: "en" })) });
    expect(await port({ store: edited, replies: usedReplies }).read({ routine, consent, turn: turn("yes") })).toBeNull();
    expect(usedReplies.reader.read).not.toHaveBeenCalled();
  });

  it("reads a reply in a replay against the wording the turn would show, since no prompt is kept", async () => {
    const usedReplies = replies("declined");
    const untouched = store();

    const read = await port({ facts: facts({ durable: false, preferredLocales: async () => ["it"] }), store: untouched, replies: usedReplies })
      .read({ routine, consent, turn: turn("no") });

    expect(read).toEqual({ decision: "declined", method: "reply", wording: italian });
    expect(untouched.latestPrompt).not.toHaveBeenCalled();
  });
});
