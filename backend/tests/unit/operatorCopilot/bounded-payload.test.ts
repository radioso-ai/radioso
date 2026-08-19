import { describe, expect, it } from "vitest";

import {
  boundConversationPayload,
  boundTurnTracePayload,
  CONVERSATION_PAYLOAD_CHAR_BUDGET,
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
