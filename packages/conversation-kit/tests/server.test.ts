import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway } from "@radioso/conversation-contract";

import { createConversationKit, createConversationKitServer } from "../src/index.js";

describe("conversation kit HTTP server", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("completes a turn over HTTP", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ messages }) => ({
        text: `http:${messages.at(-1)?.content ?? ""}`,
      })),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      agent: { id: "agent_http", name: "HTTP Agent" },
    });
    const server = createConversationKitServer({ kit });
    servers.push(server);
    const address = await server.listen({ port: 0, host: "127.0.0.1" });

    const response = await fetch(`${address.url}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello over http", sessionId: "session_http" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: "session_http",
      reply: { answer: "http:hello over http" },
    });
  });
});
