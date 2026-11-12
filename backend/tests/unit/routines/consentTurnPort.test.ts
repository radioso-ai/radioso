import { describe, expect, it, vi } from "vitest";

import type { RoutineConsentReading, TurnContext } from "@radioso/conversation-contract";

import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import { routineConsentTurnFacts } from "../../../src/modules/chat/services/routines/routineConsentTurn.js";
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
  standingByConsent: vi.fn(async () => new Map()),
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

  it.each(["email", "whatsapp", "slack"])("writes the two choices under the wording on %s, which has no buttons, each as its own paragraph", async (sourceChannel) => {
    const asked = await shown(port({ facts: facts({ sourceChannel }) }));

    expect(asked?.reply.answer).toBe(`${english.body}\n\nI agree\n\nNo thanks`);
    expect(asked?.reply.suggestions).toBeUndefined();
  });

  it("answers an unclear reply from the wording before showing it again, and asks the first time with the wording alone", async () => {
    const usedReplies = replies();
    const consentPort = port({ facts: facts({ sourceChannel: "email" }), replies: usedReplies });

    expect((await shown(consentPort))?.reply.answer).toBe(`${english.body}\n\nI agree\n\nNo thanks`);
    expect(usedReplies.answerer.answer).not.toHaveBeenCalled();

    const again = await shown(consentPort, true);
    expect(again?.reply.answer).toBe(`We only use it to plan your class.\n\n${english.body}\n\nI agree\n\nNo thanks`);
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
    const decisions = store({ standingByConsent: vi.fn(async () => new Map([["health", "granted" as const]])) });

    const standing = await port({ store: decisions }).standing({ routine, turn: turn("hi") });

    expect(standing.decisions).toEqual({ health: "granted" });
    expect(decisions.standingByConsent).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      routineId: routine.id,
      versionIdsByConsent: new Map([["health", [english, italian, portuguese].map(routineConsentWordingVersionId)]]),
    });
  });

  it("reads every consent of the routine in one lookup", async () => {
    const diet = { locale: "en", body: "We ask about allergies only to plan your meals.", agreeLabel: "Fine", declineLabel: "Rather not" };
    const base = definition([english]);
    const twoConsents = compileRoutineDefinition({
      ...base,
      slots: [...base.slots, { stableSlotId: "slot_allergy", key: "allergy", type: "text", required: true, description: null, ordinal: 1, sensitivity: "sensitive" }],
      steps: [{ ...base.steps[0], instruction: "Ask about {{slot.injury}} and {{slot.allergy}}." }],
      consents: [...base.consents!, { key: "diet", slotKeys: ["allergy"], variants: [diet], onDecline: "continue" }],
    });
    const decisions = store({ standingByConsent: vi.fn(async () => new Map([["diet", "declined" as const]])) });

    const standing = await port({ store: decisions }).standing({ routine: twoConsents, turn: turn("hi") });

    expect(standing.decisions).toEqual({ diet: "declined" });
    expect(decisions.standingByConsent).toHaveBeenCalledTimes(1);
    expect(decisions.standingByConsent).toHaveBeenCalledWith(expect.objectContaining({
      versionIdsByConsent: new Map([
        ["health", [routineConsentWordingVersionId(english)]],
        ["diet", [routineConsentWordingVersionId(diet)]],
      ]),
    }));
  });

  it.each(["voice", "mcp", "agent_api", "a2a"])("reads no decision on %s, where no consent is asked", async (sourceChannel) => {
    const decisions = store();

    expect(await port({ facts: facts({ sourceChannel }), store: decisions }).standing({ routine, turn: turn("hi") }))
      .toEqual({ asks: false, decisions: {} });
    expect(decisions.standingByConsent).not.toHaveBeenCalled();
  });

  it("holds no decision for a consent the conversation never decided", async () => {
    expect((await port().standing({ routine, turn: turn("hi") })).decisions).toEqual({});
  });

  it("reads a conversation no row is kept for from the store its own session carries, as Test Chat binds it", async () => {
    const session = store({ standingByConsent: vi.fn(async () => new Map([["health", "granted" as const]])) });

    const standing = await port({ facts: facts({ durable: false }), store: session }).standing({ routine, turn: turn("hi") });

    expect(standing).toEqual({ asks: true, decisions: { health: "granted" } });
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

  it("reads a reply in a replay whose session carries no prompt against the wording the turn would show", async () => {
    const usedReplies = replies("declined");

    const read = await port({ facts: facts({ durable: false, preferredLocales: async () => ["it"] }), store: store(), replies: usedReplies })
      .read({ routine, consent, turn: turn("no") });

    expect(read).toEqual({ decision: "declined", method: "reply", wording: italian });
  });
});

describe("a click on a consent's button (#1544)", () => {
  const PROMPT_ID = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
  const lastShownItalian = () => store({
    latestPrompt: vi.fn(async () => ({ messageId: PROMPT_ID, wordingVersionId: routineConsentWordingVersionId(italian), locale: "it" })),
  });
  const clicked = (suggestionId: string, suggestionSourceMessageId = PROMPT_ID) =>
    facts({ userMessage: { id: "message_2", inputMetadata: { method: "suggestion_click", suggestionSourceMessageId, suggestionId } } });

  it("records the chip's decision against the wording that prompt showed, without reading the message", async () => {
    const usedReplies = replies("unclear");

    const agreed = await port({ facts: clicked("agree"), store: lastShownItalian(), replies: usedReplies }).read({ routine, consent, turn: turn("Acconsento") });
    const declined = await port({ facts: clicked("decline"), store: lastShownItalian(), replies: usedReplies }).read({ routine, consent, turn: turn("No grazie") });

    expect(agreed).toEqual({ decision: "granted", method: "button", wording: italian });
    expect(declined).toEqual({ decision: "declined", method: "button", wording: italian });
    expect(usedReplies.reader.read).not.toHaveBeenCalled();
  });

  it("takes the decision from the chip id, never from the label text the message carries", async () => {
    const read = await port({ facts: clicked("agree"), store: lastShownItalian(), replies: replies("declined") })
      .read({ routine, consent, turn: turn("No grazie") });

    expect(read).toEqual({ decision: "granted", method: "button", wording: italian });
  });

  it("reads a click on an older prompt, another message, or an unknown chip as a typed reply", async () => {
    for (const metadata of [
      clicked("agree", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
      clicked("maybe"),
      clicked("constructor"),
      facts({ userMessage: { id: "message_2", inputMetadata: { method: "typed" } } }),
      facts({ userMessage: { id: "message_2", inputMetadata: { method: "intent_click", suggestionSourceMessageId: PROMPT_ID, suggestionId: "agree" } } }),
    ]) {
      const usedReplies = replies("unclear");
      const read = await port({ facts: metadata, store: lastShownItalian(), replies: usedReplies }).read({ routine, consent, turn: turn("Acconsento") });
      expect(read).toEqual({ decision: "unclear", method: "reply", wording: italian });
      expect(usedReplies.reader.read).toHaveBeenCalledOnce();
    }
  });

  it("reads a click as a typed reply on a channel that shows the choices as text, where no button was ever shown", async () => {
    for (const sourceChannel of ["email", "whatsapp", "slack", "workbench_replay", "operator_copilot_probe"]) {
      const usedReplies = replies("unclear");
      const textChannel = facts({
        sourceChannel,
        userMessage: { id: "message_2", inputMetadata: { method: "suggestion_click", suggestionSourceMessageId: PROMPT_ID, suggestionId: "agree" } },
      });

      const read = await port({ facts: textChannel, store: lastShownItalian(), replies: usedReplies }).read({ routine, consent, turn: turn("Acconsento") });

      expect(read, sourceChannel).toEqual({ decision: "unclear", method: "reply", wording: italian });
      expect(usedReplies.reader.read).toHaveBeenCalledOnce();
    }
  });

  it("cannot bind a click to wording when the conversation shows no prompt it can verify", async () => {
    expect(await port({ facts: clicked("agree"), replies: replies("granted") }).read({ routine, consent, turn: turn("I agree") })).toBeNull();
  });
});

describe("the language a consent is shown in mid-routine (#1544)", () => {
  // A turn an active routine holds runs no turn plan; its language comes from the detector alone.
  const midRoutine = (sourceChannel: string): PreparedSession => ({
    conversation: { id: "conversation_1", visitorId: "visitor_1", sourceChannel },
    userMessage: { id: "message_2", content: "Mi chiamo Ada" },
    agent: { id: "agent_1", assistantDefaultLocale: "en" },
    pageContext: null,
  }) as unknown as PreparedSession;

  it.each(["whatsapp", "email"])("shows the Italian wording on %s to a visitor writing Italian, over the agent's English default", async (sourceChannel) => {
    const turnFacts = routineConsentTurnFacts(midRoutine(sourceChannel), Promise.resolve("Italian"));

    expect(await turnFacts.preferredLocales()).toEqual(["it"]);
    const asked = await shown(port({ facts: turnFacts }));
    // The wording shown is what the decision is recorded against, language included.
    expect(asked?.wording).toEqual(italian);
    expect(asked?.wording.locale).toBe("it");
    expect(asked?.reply.answer).toBe(`${italian.body}\n\n${italian.agreeLabel}\n\n${italian.declineLabel}`);
  });

  it("falls back to the agent's default when the turn's language is unknown", async () => {
    const turnFacts = routineConsentTurnFacts(midRoutine("whatsapp"), Promise.resolve(undefined));

    expect(await turnFacts.preferredLocales()).toEqual([]);
    expect((await shown(port({ facts: turnFacts })))?.wording).toEqual(english);
  });
});
