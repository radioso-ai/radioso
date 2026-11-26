import { describe, expect, it, vi } from "vitest";

import { composeConnectorChatPort } from "../../../src/app/composition/connectorChat.js";

type ChatPortDependencies = Parameters<typeof composeConnectorChatPort>[0];

const NUMBER = "15550100101";

/** The chat port each connector gets, over a chat service that records the turns it runs. */
const portsFor = () => {
  const answer = vi.fn(async () => ({ conversationId: "conversation-1", answer: "Hello again.", skillOutcome: "grounded" }));
  const dependencies = { chatService: { answer }, metricsRegistry: { incrementCounter: vi.fn() } } as unknown as ChatPortDependencies;
  return { answer, portOf: (connectorId: string) => composeConnectorChatPort(dependencies, connectorId) };
};

describe("the chat port composition hands each connector", () => {
  it("runs a WhatsApp connector's turn as the number it attests", async () => {
    const { answer, portOf } = portsFor();

    await portOf("whatsapp").answer({ workspaceId: "workspace-1", query: "Hi", personKey: { id: NUMBER } });

    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ channelPersonKey: { kind: "whatsapp_contact", id: NUMBER } }));
  });

  it("never runs another connector's turn as a WhatsApp number", async () => {
    const { answer, portOf } = portsFor();

    await portOf("slack").answer({ workspaceId: "workspace-1", query: "Hi", personKey: { id: NUMBER } });

    expect(answer).toHaveBeenCalledWith(expect.not.objectContaining({ channelPersonKey: expect.anything() }));
  });
});
