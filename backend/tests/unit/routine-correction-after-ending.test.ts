import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  ProcessTurnResult,
} from "@radioso/conversation-contract";

import { setTraceAttributes } from "../../src/shared/observability/tracing/operations.js";
import { BOOK_STAY_ROUTINE_ID, startBookingConversation } from "../support/bookingConversationHarness.js";

vi.mock("../../src/shared/observability/tracing/operations.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/shared/observability/tracing/operations.js")>(),
  setTraceAttributes: vi.fn(),
}));

/**
 * #1714, through the production routine wiring with the model scripted per visitor message:
 * after a booking ends, a later message is a correction only to a date the run holds, and only
 * while the run told no one; a request for something new goes on to activation.
 */

interface Visitor {
  /** Whether the activator should start the booking for this message. */
  activates: boolean;
  /** The selector's read of this message: the exit it takes and the dates it reads. */
  selects?: { exit: "just_looking" | "requested"; dates: Record<string, string> };
  /** The correction detector's JSON answer for this message. */
  detects?: { intent: "correction" | "new_request" | "other"; slotKey?: string; value?: string };
}

const latestMessage = (request: ConversationModelRequest): string => request.messages.at(-1)?.content ?? "";

/**
 * The number the selector prompt gives the "only looking" exit. The exit to the request has no
 * condition of its own: it fires once both dates are held.
 */
const justLookingCondition = (systemPrompt: string): number => {
  const line = [...systemPrompt.matchAll(/^(\d+)\. (.*)$/gm)].find(([, , text]) => text.includes("only looking"));
  if (!line) {
    throw new Error("the selector prompt lists no exit for a visitor who is only looking");
  }
  return Number(line[1]);
};

const scriptedModel = (visitors: Record<string, Visitor>): ConversationModelGateway => ({
  complete: vi.fn(async (request: ConversationModelRequest) => {
    const visitor = visitors[latestMessage(request)];
    if (!visitor) {
      throw new Error(`no script for "${latestMessage(request)}"`);
    }
    const metadata = request.metadata ?? {};
    if (metadata.routineActivation === true) {
      return { text: JSON.stringify({ matches: visitor.activates ? [{ routineId: BOOK_STAY_ROUTINE_ID, confidence: 0.9 }] : [] }) };
    }
    if (metadata.routineSlotCorrectionDetect === true) {
      const detects = visitor.detects ?? { intent: "other" };
      return { text: JSON.stringify({ intent: detects.intent, slotKey: detects.slotKey ?? null, value: detects.value ?? null }) };
    }
    if (metadata.routineSlotCorrectionConfirm === true) {
      return { text: "Noted, your arrival is now the 9th." };
    }
    if (request.systemPrompt?.includes("claimsAuthority")) {
      const selects = visitor.selects;
      return {
        text: JSON.stringify({
          claimsAuthority: false,
          offTopic: false,
          condition: selects?.exit === "just_looking" ? justLookingCondition(request.systemPrompt) : null,
          variables: selects?.dates ?? {},
        }),
      };
    }
    return { text: "A reply from the step." };
  }),
});

const modelCalls = (gateway: ConversationModelGateway, flag: string): ConversationModelRequest[] =>
  vi.mocked(gateway.complete).mock.calls.map(([request]) => request).filter((request) => request.metadata?.[flag] === true);

const correctionStage = (result: ProcessTurnResult | null) =>
  result?.trace.stages.find((stage) => stage.kind === "routine_slot_correction");

const decisionsTraced = (): unknown[] =>
  vi.mocked(setTraceAttributes).mock.calls
    .map(([attributes]) => attributes["routine.slot_correction.decision"])
    .filter((decision) => decision !== undefined);

const JUST_LOOKING = "Hi! I'm only looking at your rooms for now.";
const PRICE_QUESTION = "How much is a double room?";
const BOOK_JANUARY = "I'd like to book from 8 to 10 January";

describe("a message after a booking routine ended (#1714)", () => {
  beforeEach(() => {
    vi.mocked(setTraceAttributes).mockClear();
  });

  it("starts the booking again for a new request after a run that ended holding nothing, and claims no update", async () => {
    const model = scriptedModel({
      [JUST_LOOKING]: { activates: true, selects: { exit: "just_looking", dates: {} } },
      [PRICE_QUESTION]: { activates: false },
      [BOOK_JANUARY]: {
        activates: true,
        selects: { exit: "requested", dates: { arrival: "2027-01-08", departure: "2027-01-10" } },
        // Were the detector asked, it would take the dates as a change to the arrival.
        detects: { intent: "correction", slotKey: "arrival", value: "2027-01-08" },
      },
    });
    const conversation = await startBookingConversation(model);

    const opening = await conversation.send(JUST_LOOKING);
    expect(opening?.decision.reason).toBe(`routine_activated:${BOOK_STAY_ROUTINE_ID}`);
    expect(opening?.operatorNotice).toBeUndefined();
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: {} });

    expect(await conversation.send(PRICE_QUESTION)).toBeNull();

    const booking = await conversation.send(BOOK_JANUARY);

    expect(booking?.decision.reason).toBe(`routine_activated:${BOOK_STAY_ROUTINE_ID}`);
    expect(correctionStage(booking)).toBeUndefined();
    // The request reaches the booking team, with the dates the visitor asked for.
    expect(booking?.operatorNotice).toMatchObject({
      routineId: BOOK_STAY_ROUTINE_ID,
      collected: { arrival: "2027-01-08", departure: "2027-01-10" },
    });
    expect(modelCalls(model, "routineSlotCorrectionDetect")).toHaveLength(0);
    expect(modelCalls(model, "routineSlotCorrectionConfirm")).toHaveLength(0);
    expect(decisionsTraced()).toEqual(["not_held", "not_held"]);
  });

  it("offers no correction once the ending notified the booking team", async () => {
    const changeArrival = "Sorry, I'll arrive on the 9th instead.";
    const model = scriptedModel({
      [BOOK_JANUARY]: {
        activates: true,
        selects: { exit: "requested", dates: { arrival: "2027-01-08", departure: "2027-01-10" } },
      },
      [changeArrival]: { activates: false, detects: { intent: "correction", slotKey: "arrival", value: "2027-01-09" } },
    });
    const conversation = await startBookingConversation(model);

    expect((await conversation.send(BOOK_JANUARY))?.operatorNotice).toBeDefined();
    const change = await conversation.send(changeArrival);

    expect(change).toBeNull();
    expect(modelCalls(model, "routineSlotCorrectionDetect")).toHaveLength(0);
    expect(modelCalls(model, "routineSlotCorrectionConfirm")).toHaveLength(0);
    expect(await conversation.routineState()).toMatchObject({
      status: "completed",
      variables: { arrival: "2027-01-08", departure: "2027-01-10" },
    });
    expect(decisionsTraced()).toEqual(["already_sent"]);
  });

  it("corrects a date a run that told no one holds, and still starts a new booking for a new request", async () => {
    const lookingWithArrival = "I might arrive on 8 January, but I'm only looking for now.";
    const changeArrival = "Actually, make the arrival the 9th.";
    const model = scriptedModel({
      [lookingWithArrival]: { activates: true, selects: { exit: "just_looking", dates: { arrival: "2027-01-08" } } },
      [changeArrival]: { activates: false, detects: { intent: "correction", slotKey: "arrival", value: "2027-01-09" } },
      [BOOK_JANUARY]: {
        activates: true,
        selects: { exit: "requested", dates: { arrival: "2027-01-08", departure: "2027-01-10" } },
        detects: { intent: "new_request" },
      },
    });
    const conversation = await startBookingConversation(model);

    await conversation.send(lookingWithArrival);
    const change = await conversation.send(changeArrival);

    expect(change?.decision.reason).toBe("routine_slot_correction");
    expect(correctionStage(change)).toMatchObject({ status: "applied", outputs: { slotKey: "arrival" } });
    expect(await conversation.routineState()).toMatchObject({ status: "completed", variables: { arrival: "2027-01-09" } });
    // The detector saw the date the run held and today's date, and only the editable value it holds.
    const detectPrompt = modelCalls(model, "routineSlotCorrectionDetect")[0]?.systemPrompt ?? "";
    expect(detectPrompt).toContain("holds: 2027-01-08");
    expect(detectPrompt).toMatch(/Today is \d{4}-\d{2}-\d{2} \(UTC\)/);
    expect(detectPrompt).not.toContain("key: departure");

    const booking = await conversation.send(BOOK_JANUARY);

    expect(booking?.decision.reason).toBe(`routine_activated:${BOOK_STAY_ROUTINE_ID}`);
    expect(correctionStage(booking)).toBeUndefined();
    expect(booking?.operatorNotice).toMatchObject({ collected: { arrival: "2027-01-08", departure: "2027-01-10" } });
    expect(decisionsTraced()).toEqual(["correction", "new_request"]);
  });
});
