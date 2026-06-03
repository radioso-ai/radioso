import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway } from "@radioso/conversation-contract";

import { createConversationKitClient } from "../src/index.js";

describe("conversation kit SDK facade", () => {
  it("supports the hello-world flow: create agent, add directive, session, message, reply", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ messages }) => ({
        text: `Hello from the kit: ${messages.at(-1)?.content ?? ""}`,
      })),
    };
    const client = createConversationKitClient({ modelGateway: gateway });

    const agent = client.createAgent({
      name: "Hello World",
      instructions: ["Greet developers clearly."],
    });
    client.addDirective(agent.id, {
      name: "concise",
      condition: { kind: "always" },
      action: "Keep the answer concise.",
    });
    const session = client.createSession({ agentId: agent.id });

    const reply = await client.sendMessage({
      sessionId: session.id,
      message: "Can you run without the Radioso backend?",
    });

    expect(reply.answer).toBe("Hello from the kit: Can you run without the Radioso backend?");
    expect(client.getSession(session.id)?.agentId).toBe(agent.id);
    expect(client.listEvents(session.id).map((event) => event.role)).toEqual(["user", "assistant"]);
  });
});
