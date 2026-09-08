import { describe, expect, it } from "vitest";

import { AGENT_BUDGET_CEILINGS, estimateAgentResultTokens } from "../../../src/shared/agent-runtime/index.js";
import { COPILOT_TURN_BUDGET } from "../../../src/modules/operatorCopilot/turnBudget.js";
import { compactForBudget, serializedLength, withTruncation } from "../../../src/modules/operatorCopilot/payloadCompaction.js";
import {
  boundConversationPayload,
  boundTurnTracePayload,
  CONVERSATION_PAYLOAD_CHAR_BUDGET,
  TURN_TRACE_PAYLOAD_CHAR_BUDGET,
} from "../../../src/modules/operatorCopilot/tools/chatPayloadBounds.js";

describe("boundConversationPayload", () => {
  it("returns small payloads compacted but structurally intact", () => {
    const payload = { conversationId: "c1", messages: [{ role: "user", content: "hi" }] };
    expect(boundConversationPayload(payload)).toEqual(payload);
  });

  it("truncates long strings and caps arrays", () => {
    const bounded = boundConversationPayload({
      note: "x".repeat(2_000),
      items: Array.from({ length: 100 }, (_, index) => index),
    });
    expect((bounded.note as string).length).toBe(501);
    expect((bounded.items as number[]).length).toBe(40);
    expect(bounded.truncation).toMatchObject({
      truncated: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "$.note", reason: "string_length" }),
        expect.objectContaining({ path: "$.items", reason: "array_length" }),
      ]),
    });
  });

  it("drops debug envelopes from the oldest messages first until under budget", () => {
    const bigDebug = () => ({ trace: Array.from({ length: 40 }, () => ({ chunk: "y".repeat(490) })) });
    const payload = {
      conversationId: "c1",
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `m${index}`,
        role: "assistant",
        content: `answer ${index}`,
        debug: bigDebug(),
      })),
    };

    const bounded = boundConversationPayload(payload);
    const messages = bounded.messages as Array<Record<string, unknown>>;

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(CONVERSATION_PAYLOAD_CHAR_BUDGET);
    expect(messages[0].debug).toBeUndefined();
    expect(messages[0].debugOmitted).toBe(true);
    expect(bounded.truncation).toMatchObject({
      truncated: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ path: "$.messages[0].debug", reason: "budget_omitted" }),
      ]),
    });
    expect(messages.at(-1)?.debug).toBeDefined();
    expect(messages.every((message) => typeof message.content === "string")).toBe(true);
  });

  it("keeps only the newest messages when the conversation is very long", () => {
    const payload = {
      conversationId: "c1",
      messages: Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, content: "z".repeat(600), debug: { t: "d".repeat(600) } })),
    };
    const bounded = boundConversationPayload(payload);
    const messages = bounded.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(20);
    expect(messages[0].id).toBe("m40");
  });

  it("marks a deep trace truncation at the field that was shortened", () => {
    const bounded = boundTurnTracePayload({
      conversationId: "c1",
      message: {
        id: "m1",
        debug: {
          turnTrace: {
            spine: {
              stages: [{
                id: "compose",
                outputs: { modelReasoning: "x".repeat(20_000) },
              }],
            },
          },
        },
      },
    });

    expect(bounded.truncation).toMatchObject({
      truncated: true,
      entries: expect.arrayContaining([
        expect.objectContaining({
          path: "$.message.debug.turnTrace.spine.stages[0].outputs.modelReasoning",
          reason: "string_length",
        }),
      ]),
    });
  });
});

/**
 * The bug these cover: a reader's char budget and the turn's token budget were picked
 * independently, so one `turn_trace` read could cost more than the whole turn was allowed to
 * spend. The runtime charges tool results in estimated tokens and skips its closing call on token
 * exhaustion, so the operator got a blank card instead of the analysis they asked for.
 */
describe("copilot payload budgets against the turn budget", () => {
  const readers = [
    { name: "turn_trace", charBudget: TURN_TRACE_PAYLOAD_CHAR_BUDGET },
    { name: "conversation_transcript", charBudget: CONVERSATION_PAYLOAD_CHAR_BUDGET },
  ];

  it("stays inside the ceilings the runtime would otherwise clamp it to", () => {
    // A budget over a ceiling is silently reduced, which would put the turn back on a smaller
    // allowance than the readers below are sized against.
    expect(COPILOT_TURN_BUDGET.maxSteps).toBeLessThanOrEqual(AGENT_BUDGET_CEILINGS.maxSteps);
    expect(COPILOT_TURN_BUDGET.maxToolResultTokens).toBeLessThanOrEqual(AGENT_BUDGET_CEILINGS.maxToolResultTokens);
    expect(COPILOT_TURN_BUDGET.maxWallTimeMs).toBeLessThanOrEqual(AGENT_BUDGET_CEILINGS.maxWallTimeMs);
  });

  it.each(readers)("leaves $name room to answer after one full-size read", ({ charBudget }) => {
    // Strictly less, not at most: a read that spends the entire budget terminates the turn on the
    // step that produced it, which is the blank-card failure.
    expect(estimateAgentResultTokens("x".repeat(charBudget))).toBeLessThan(
      COPILOT_TURN_BUDGET.maxToolResultTokens,
    );
  });

  // A single wide collection is the easy case — the compaction ladder's array cap alone handles it.
  // These are the shapes that defeated the ladder: breadth spread across several collections, so
  // every one of them stays under the per-array cap while the payload as a whole does not.
  it("holds a trace carrying several large collections inside the trace reader's budget", () => {
    const wide = (field: string) =>
      Array.from({ length: 120 }, (_, index) => ({
        id: `${field}-${index}`,
        at: "2026-09-04T10:00:00.000Z",
        inputs: { prompt: "p".repeat(900) },
        outputs: { modelReasoning: "r".repeat(900), answer: "a".repeat(900) },
      }));
    const bounded = boundTurnTracePayload({
      conversationId: "c1",
      message: {
        id: "m1",
        debug: {
          activityTrace: wide("activity"),
          turnTrace: { spine: { stages: wide("stage") }, retrieval: { candidates: wide("candidate") } },
        },
      },
    });

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(TURN_TRACE_PAYLOAD_CHAR_BUDGET);
    expect(estimateAgentResultTokens(bounded)).toBeLessThan(COPILOT_TURN_BUDGET.maxToolResultTokens);
    expect(bounded.truncation).toMatchObject({ truncated: true });
  });

  it("holds a conversation whose bulk is outside its debug envelopes", () => {
    // The debug-dropping preference runs out immediately here — no message has a debug envelope —
    // so nothing but the budget itself keeps this payload down.
    const bounded = boundConversationPayload({
      conversationId: "c1",
      messages: Array.from({ length: 40 }, (_, index) => ({
        id: `m${index}`,
        role: "assistant",
        content: "c".repeat(900),
        citations: Array.from({ length: 60 }, (_, cited) => ({ id: `cit-${cited}`, quote: "q".repeat(900) })),
      })),
    });

    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(CONVERSATION_PAYLOAD_CHAR_BUDGET);
    expect(estimateAgentResultTokens(bounded)).toBeLessThan(COPILOT_TURN_BUDGET.maxToolResultTokens);
  });
});

describe("compactForBudget", () => {
  const ladder = [{ maxStringChars: 6_000, maxArrayItems: 160 }, { maxStringChars: 500, maxArrayItems: 40 }];

  it("keeps the most generous profile that fits", () => {
    const payload = { note: "x".repeat(1_000) };
    const compacted = compactForBudget(payload, ladder, 10_000);
    expect(compacted.value.note).toBe("x".repeat(1_000));
    expect(compacted.truncation).toEqual([]);
  });

  it("tightens past the last profile rather than returning an oversized payload", () => {
    const payload = { rows: Array.from({ length: 200 }, (_, index) => ({ id: index, text: "t".repeat(400) })) };
    const compacted = compactForBudget(payload, ladder, 2_000);
    expect(serializedLength(withTruncation(compacted.value, compacted.truncation))).toBeLessThanOrEqual(2_000);
  });

  it("gives back an empty marked record when the payload's breadth is in its keys", () => {
    // Nothing here is a long string or a long array, so no profile can shrink it. Returning the
    // payload anyway is what the budget exists to prevent.
    const payload = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${index}`, index]));
    const compacted = compactForBudget(payload, ladder, 2_000);
    expect(compacted.value).toEqual({});
    expect(compacted.truncation).toEqual([{ path: "$", reason: "budget_omitted" }]);
  });
});
