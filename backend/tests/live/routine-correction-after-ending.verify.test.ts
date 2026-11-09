/**
 * LIVE verification (not part of CI) for #1714: what a message after a booking routine ended
 * does, with every routine decision made by the real model — activation, the next-step
 * selector, the step reply, and the completed-routine correction detector — through the
 * production routine wiring and prompts. One sample per case.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/routine-correction-after-ending.verify.test.ts
 *
 * Requires OPENAI_API_KEY in the repo-root .env. Skips itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  ProcessTurnResult,
  RoutineState,
} from "@radioso/conversation-contract";

import { BOOK_STAY_ROUTINE_ID, NORMAL_ANSWER, startBookingConversation } from "../support/bookingConversationHarness.js";

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

const calls: ConversationModelRequest[] = [];

/** The production default chat model, called directly, recording each request's metadata. */
const liveModel: ConversationModelGateway = {
  async complete(request) {
    calls.push(request);
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

const detectorAnswers = (): string[] =>
  calls.filter((request) => request.metadata?.routineSlotCorrectionDetect === true).map((request) => request.systemPrompt ?? "");

const endedLookingAt = (variables: Record<string, unknown>): RoutineState => ({
  sessionId: "seed",
  routineId: BOOK_STAY_ROUTINE_ID,
  path: ["dates", "just_looking"],
  variables,
  status: "completed",
});

const report = (label: string, result: ProcessTurnResult | null): void => {
  console.info(`[${label}] decision=${result?.decision.reason ?? "normal answering"} answer=${JSON.stringify(result?.response.answer ?? null)}`);
};

const BOOK_JANUARY = "I'd like to book from 8 to 10 January";

describe.skipIf(!apiKey)("LIVE: a message after a booking routine ended (#1714)", () => {
  it("starts the booking for a new request after a run that ended holding nothing", async () => {
    calls.length = 0;
    const conversation = await startBookingConversation(liveModel, {
      completed: endedLookingAt({}),
      history: [
        { role: "user", content: "Hi! I'm only looking at your rooms for now." },
        { role: "assistant", content: "Of course, you're welcome to book whenever you like." },
        { role: "user", content: "How much is a double room?" },
        { role: "assistant", content: NORMAL_ANSWER },
      ],
    });

    const result = await conversation.send(BOOK_JANUARY);
    report("nothing held", result);

    expect(detectorAnswers()).toHaveLength(0);
    expect(result?.decision.reason).toBe(`routine_activated:${BOOK_STAY_ROUTINE_ID}`);
  }, 120_000);

  it("reads a booking with new dates as a new request, not a change to the arrival the run holds", async () => {
    calls.length = 0;
    const conversation = await startBookingConversation(liveModel, {
      completed: endedLookingAt({ arrival: "2027-01-05" }),
      history: [
        { role: "user", content: "I might arrive on 5 January, but I'm only looking for now." },
        { role: "assistant", content: "No problem, you're welcome to book whenever you like." },
      ],
    });

    const result = await conversation.send(BOOK_JANUARY);
    report("new request", result);

    expect(detectorAnswers()).toHaveLength(1);
    expect(result?.decision.reason).toBe(`routine_activated:${BOOK_STAY_ROUTINE_ID}`);
  }, 120_000);

  it("changes the arrival the run holds when the visitor asks to, dated from today", async () => {
    calls.length = 0;
    const conversation = await startBookingConversation(liveModel, {
      completed: endedLookingAt({ arrival: "2027-01-05" }),
      history: [
        { role: "user", content: "I might arrive on 5 January, but I'm only looking for now." },
        { role: "assistant", content: "No problem, you're welcome to book whenever you like." },
      ],
    });

    const result = await conversation.send("Actually, I'd arrive on 9 January instead.");
    report("correction", result);

    expect(result?.decision.reason).toBe("routine_slot_correction");
    expect(await conversation.routineState()).toMatchObject({ variables: { arrival: "2027-01-09" } });
  }, 120_000);
});
