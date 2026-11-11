/**
 * LIVE verification (not part of CI) for #1544: how the real model reads a visitor's typed reply
 * to a consent they were just shown, through the production consent port and the shipped
 * `routine-consent-reply.md` prompt, and what the agent says before showing the consent again
 * after an unclear reply (`routine-consent-unclear-answer.md`). One sample per case, in English
 * and Italian. SC-003: no ambiguous or refusing reply is ever read as `granted`.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/routine-consent-reply.verify.test.ts
 *
 * Requires OPENAI_API_KEY in the repo-root .env. Skips itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ConversationModelGateway, RoutineConsentReading, TurnContext } from "@radioso/conversation-contract";
import { RoutineConsentReplyReader, RoutineConsentUnclearAnswerer } from "@radioso/conversation-defaults";

import { createRoutineConsentTurnPort } from "../../src/modules/routines/consent/consentTurnPort.js";
import { compileRoutineDefinition, type RoutineDefinition } from "../../src/modules/routines/public.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { routineConsentWordingVersionId } from "../../src/shared/domain/routineConsentWording.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

const apiKey = (() => {
  try {
    return /OPENAI_API_KEY=(\S+)/.exec(readFileSync(path.join(repoRoot, ".env"), "utf8"))?.[1];
  } catch {
    return undefined;
  }
})();

const MODEL = "gpt-5.4-mini";

const liveModel: ConversationModelGateway = {
  async complete(request) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        reasoning_effort: "low",
        messages: [
          ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
    });
    const json = (await response.json()) as { choices?: Array<{ message: { content: string } }>; error?: { message?: string } };
    if (!json.choices) {
      throw new Error(`model call failed: ${json.error?.message ?? response.status}`);
    }
    return { text: json.choices[0].message.content };
  },
};

const english = {
  locale: "en",
  body: "Before we plan your class we ask about any health condition, so the teacher can adapt it. We use your answer only for this booking and delete it when the class is over.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};
const italian = {
  locale: "it",
  body: "Prima di organizzare la lezione ti chiediamo eventuali condizioni di salute, così l'insegnante può adattarla. Usiamo la tua risposta solo per questa prenotazione e la cancelliamo a lezione finita.",
  agreeLabel: "Acconsento",
  declineLabel: "No grazie",
};

const definition: RoutineDefinition = {
  id: "routine-class-booking",
  agentId: "agent_1",
  lineageId: "routine-class-booking",
  name: "Book a class",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor wants to book a class.", gateRef: null, priority: 0, reentryMode: "once_per_conversation" },
  slots: [{ stableSlotId: "slot_condition", key: "condition", type: "text", required: true, description: null, ordinal: 0, sensitivity: "sensitive" }],
  steps: [{ stableStepId: "ask_condition", kind: "chat", instruction: "Ask about {{slot.condition}}.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "ask_condition", toRef: "done", guardKind: "default", guardText: null, ordinal: 0 }],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: "Confirm the booking.", ordinal: 0 }],
  consents: [{ key: "health", slotKeys: ["condition"], variants: [english, italian], onDecline: "continue" }],
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:00.000Z"),
};
const routine = compileRoutineDefinition(definition);
const consent = routine.consents![0];

/** The production consent port on a text channel, where the conversation last showed `wording`. */
const portFor = (wording: typeof english) =>
  createRoutineConsentTurnPort({
    facts: {
      conversationId: "conversation_1",
      visitorId: null,
      sourceChannel: "whatsapp",
      userMessage: { id: "message_2" },
      preferredLocales: async () => [wording.locale],
      agentDefaultLocale: "en",
      durable: true,
    },
    store: {
      standingByConsent: async () => new Map(),
      latestPrompt: async () => ({ messageId: "message_1", wordingVersionId: routineConsentWordingVersionId(wording), locale: wording.locale }),
    },
    reader: new RoutineConsentReplyReader(liveModel, { promptTemplate: loadPromptTemplate("chat/routine-consent-reply.md") }),
    answerer: new RoutineConsentUnclearAnswerer(liveModel, { promptTemplate: loadPromptTemplate("chat/routine-consent-unclear-answer.md") }),
  });

const turnWith = (reply: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "conversation_1",
  inputEvent: { id: "message_2", kind: "message", content: reply },
  history: [],
  stagedContext: [],
  steering: [],
});

/** Reads `reply` as an answer to `wording`, the consent the conversation last showed. */
const readReply = async (wording: typeof english, reply: string): Promise<RoutineConsentReading | undefined> => {
  const read = await portFor(wording).read({ routine, consent, turn: turnWith(reply) });
  console.info(`[${wording.locale}] ${JSON.stringify(reply)} -> ${read?.decision ?? "no reading"}`);
  return read?.decision;
};

/** What the agent says before showing `wording` again after the unclear `reply`. */
const leadBeforeReask = async (wording: typeof english, reply: string): Promise<string> => {
  const prompt = await portFor(wording).prompt({ routine, consent, turn: turnWith(reply), reask: true });
  if (!prompt) throw new Error("the consent was not shown");
  const { answer } = await prompt.reply.render();
  const lead = answer.slice(0, answer.indexOf(wording.body)).trim();
  console.info(`[${wording.locale}] ${JSON.stringify(reply)} -> lead ${JSON.stringify(lead)}`);
  return lead;
};

interface LeadReview {
  /** It answers the question with what the wording says, rather than only pointing back to it. */
  answers: boolean;
  /** It states a fact, purpose, recipient, right or promise the wording does not. */
  adds: boolean;
  /** It tells the person they must or have to choose, rather than inviting them to. */
  orders: boolean;
}

/** A second model call that reviews a lead against the wording, the way a reviewer would. */
const reviewLead = async (wording: typeof english, reply: string, lead: string): Promise<LeadReview> => {
  const { text } = await liveModel.complete({
    systemPrompt: [
      "You review a short message an assistant wrote to a person who was shown the consent request below and answered unclearly.",
      'Return only JSON: {"answers": boolean, "adds": boolean, "orders": boolean}.',
      '- "answers": true when the message answers the person\'s question using what the request says; false when it says it can only go by the request, or answers nothing.',
      '- "adds": true when the message states any fact, purpose, recipient, right, or promise the request does not state. Restating the request in other words is not adding.',
      '- "orders": true when the message tells the person they must or have to choose, rather than inviting them to.',
      `The request:\n<request>\n${wording.body}\n</request>`,
    ].join("\n"),
    messages: [{ role: "user", content: `The person wrote: ${reply}\nThe assistant's message: ${lead}` }],
  });
  const review = JSON.parse(text) as LeadReview;
  console.info(`[${wording.locale}] review of ${JSON.stringify(lead)}: ${JSON.stringify(review)}`);
  return review;
};

const cases: Array<{ wording: typeof english; reply: string; expected: "granted" | "declined" | "not granted" }> = [
  { wording: english, reply: "Yes, I agree to that.", expected: "granted" },
  { wording: english, reply: "No, I'd rather not share that.", expected: "declined" },
  { wording: english, reply: "ok", expected: "not granted" },
  { wording: english, reply: "What do you do with it?", expected: "not granted" },
  { wording: english, reply: "Yes, as long as you don't tell my employer.", expected: "not granted" },
  { wording: english, reply: "Yes, I have celiac disease.", expected: "granted" },
  { wording: italian, reply: "Sì, acconsento.", expected: "granted" },
  { wording: italian, reply: "No, preferisco di no.", expected: "declined" },
  { wording: italian, reply: "ok", expected: "not granted" },
  { wording: italian, reply: "Cosa ne fate?", expected: "not granted" },
  { wording: italian, reply: "Sì, purché non lo diciate al mio datore di lavoro.", expected: "not granted" },
  { wording: italian, reply: "Sì, ho la celiachia.", expected: "granted" },
];

describe.skipIf(!apiKey)("LIVE: a visitor's typed reply to a consent (#1544)", () => {
  it.each(cases)("[$wording.locale] reads $reply as $expected", async ({ wording, reply, expected }) => {
    const decision = await readReply(wording, reply);

    if (expected === "not granted") {
      expect(decision).not.toBe("granted");
    } else {
      expect(decision).toBe(expected);
    }
  }, 120_000);

  it("answers a question the wording answers from the wording, adding nothing to it", async () => {
    const reply = "What do you do with this?";
    const lead = await leadBeforeReask(english, reply);

    expect(lead).not.toBe("");
    expect(await reviewLead(english, reply, lead)).toMatchObject({ answers: true, adds: false });
  }, 120_000);

  it.each([english, italian])("[$locale] invites a reply that asks nothing to choose, politely and without a question", async (wording) => {
    const lead = await leadBeforeReask(wording, "ok");

    expect(lead).not.toBe("");
    expect(lead).not.toContain("?");
    expect(await reviewLead(wording, "ok", lead)).toMatchObject({ adds: false, orders: false });
  }, 120_000);
});
