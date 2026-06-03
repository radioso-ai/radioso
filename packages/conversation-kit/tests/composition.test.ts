import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway } from "@radioso/conversation-contract";

import { createConversationKit } from "../src/index.js";

describe("createConversationKit", () => {
  it("runs a full turn through defaults, engine, and a mock model gateway", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt, messages }) => ({
        text: `reply:${messages.at(-1)?.content ?? ""}`,
        metadata: {
          sawDirective: systemPrompt?.includes("Answer in one sentence.") ?? false,
        },
      })),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      agent: {
        id: "agent_hello",
        name: "Hello Agent",
        instructions: ["Be useful."],
      },
      directives: [
        {
          name: "brief",
          condition: { kind: "always" },
          action: "Answer in one sentence.",
        },
      ],
    });

    const result = await kit.runTurn({
      sessionId: "session_hello",
      message: "Hello kit",
    });

    expect(result.response.answer).toBe("reply:Hello kit");
    expect(result.response.metadata).toMatchObject({ sawDirective: true });
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "gather",
      "directive_match",
      "skill_selection",
      "compose",
    ]);
    expect(gateway.complete).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Hello kit" }],
      systemPrompt: expect.stringContaining("Answer in one sentence."),
    }));
    expect(kit.listEvents("session_hello").map((event) => event.role)).toEqual(["user", "assistant"]);
  });
});
