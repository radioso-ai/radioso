import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway } from "@radioso/conversation-contract";

import { createModelBackedConversationComposer } from "../src/index.js";

describe("createModelBackedConversationComposer", () => {
  it("tells the host its completion is text a visitor reads", async () => {
    const complete = vi.fn(async () => ({ text: "Hello." }));
    const gateway: ConversationModelGateway = { complete };
    const composer = createModelBackedConversationComposer(gateway);

    await composer.compose({
      turn: {
        sessionId: "session_1",
        agent: { id: "agent_1" },
        steering: [],
        history: [],
        inputEvent: { content: "Hi" },
      },
      decision: { selected: [] },
      outcomes: [],
      steering: [],
    } as unknown as Parameters<typeof composer.compose>[0]);

    const request: unknown = (complete.mock.calls as unknown[][])[0]?.[0];
    expect(request).toMatchObject({ writesVisitorText: true });
  });
});
