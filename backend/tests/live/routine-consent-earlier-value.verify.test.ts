/**
 * LIVE verification (not part of CI) for #1544, option A: a covered value the visitor stated
 * before the consent is kept once they have granted it. The visitor says they are coeliac, grants
 * the consent, and answers the dietary step's "anything else?" with "No, nient'altro."; the real
 * next-step selector, with the shipped prompts and the slots the runner lets it read from earlier
 * messages, must store the coeliac condition rather than the reply's words. One sample.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/routine-consent-earlier-value.verify.test.ts
 *
 * Requires OPENAI_API_KEY in the repo-root .env. Skips itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ConversationModelGateway, ConversationRoutineConsentPort, Routine, TurnContext } from "@radioso/conversation-contract";
import { RoutineNextStepSelector } from "@radioso/conversation-defaults";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";

import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

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

const GATE = "consent:health:ask_diet";
const WORDING = "Prima di organizzare la lezione ti chiediamo eventuali esigenze alimentari, così l'insegnante può adattarla. Usiamo la tua risposta solo per questa prenotazione.";

// A class booking as the compiler gives it: the consent step sits before the dietary step.
const booking: Routine = {
  id: "class-booking",
  rootStepId: GATE,
  slots: [{ id: "slot_diet", key: "dietary_needs", type: "text", required: true, sensitivity: "sensitive", description: "Any food intolerance, allergy or dietary need the teacher should know about." }],
  consents: [{ key: "health", slotKeys: ["dietary_needs"], onDecline: "continue" }],
  steps: [
    { id: GATE, kind: "consent", consentKey: "health" },
    { id: "ask_diet", kind: "chat", action: "Ask whether the visitor has any dietary needs, and record them as {{slot.dietary_needs}}.", metadata: { collectsSlots: ["dietary_needs"] } },
    { id: "done", kind: "terminal", action: "Confirm the booking." },
  ],
  transitions: [
    { from: GATE, to: "ask_diet", condition: "", guard: { kind: "default" } },
    { from: "ask_diet", to: "done", condition: "dietary needs given", guard: { kind: "slot_filled", slots: ["dietary_needs"] } },
  ],
};

// The conversation already granted the consent; nothing here reads or records a decision.
const granted: ConversationRoutineConsentPort = {
  standing: async () => ({ asks: true, decisions: { health: "granted" } }),
  read: async () => null,
  prompt: async () => null,
};

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "conversation_1",
  inputEvent: { id: "message_5", kind: "message", content: "No, nient'altro." },
  history: [
    { role: "user", content: "Vorrei prenotare una lezione di yoga. Sono celiaco." },
    { role: "assistant", content: `${WORDING}\n\nAcconsento\n\nNo grazie` },
    { role: "user", content: "Sì, acconsento." },
    { role: "assistant", content: "Grazie! Oltre alla celiachia, hai altre esigenze alimentari di cui l'insegnante dovrebbe sapere?" },
  ],
  stagedContext: [],
  steering: [],
};

describe.skipIf(!apiKey)("LIVE: a covered value stated before the grant (#1544)", () => {
  it("keeps the coeliac condition stated before the grant when the visitor adds nothing", async () => {
    const runner = new DefaultRoutineRunner(
      [booking],
      new RoutineNextStepSelector(liveModel, {
        promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
        slotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-slots.md"),
        filledSlotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-filled-slots.md"),
        dateRulePromptTemplate: loadPromptTemplate("chat/routine-next-step-date-rule.md"),
        earlierSlotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-earlier-slots.md"),
        slotFallbackPromptTemplate: loadPromptTemplate("chat/routine-next-step-slot-fallback.md"),
      }),
      { render: async ({ step }) => ({ answer: `[${step.id}]` }) },
      undefined,
      { consent: granted },
    );

    const result = await runner.resume({
      turn,
      state: { sessionId: "conversation_1", routineId: booking.id, path: [GATE, "ask_diet"], variables: {}, status: "active" },
    });

    const stored = result.endedVariables?.dietary_needs ?? result.nextState?.variables.dietary_needs;
    console.info(`[it] "No, nient'altro." -> dietary_needs ${JSON.stringify(stored)}`);
    expect(String(stored)).toMatch(/celia|coeliac|celiac/i);
  }, 120_000);
});
