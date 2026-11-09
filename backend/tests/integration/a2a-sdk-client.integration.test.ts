import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SendMessageRequest, TaskState, type SendMessageResult, type Task } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { afterEach, describe, expect, it } from "vitest";

import { createA2aTestApp, openA2aAgent, supportIntakeDraft } from "../support/a2aTestApp.js";

/** A free port, so the card the server publishes can name the address the server listens on. */
const freePort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
};

const asTask = (result: SendMessageResult): Task => {
  if (!("status" in result)) throw new Error("expected a task, got a message");
  return result;
};

const textMessage = (text: string, ids: { contextId?: string; taskId?: string } = {}) => SendMessageRequest.fromJSON({
  message: { messageId: `sdk-${Math.random().toString(36).slice(2)}`, role: "ROLE_USER", parts: [{ text }], ...ids },
});

describe("SC-001: an off-the-shelf A2A v1.0 client completes a routine against a walk-in agent", () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it("reads the card, sends, reaches INPUT_REQUIRED, answers with the task id, and reaches COMPLETED", async () => {
    const port = await freePort();
    const ctx = createA2aTestApp({ envOverrides: { CONNECTOR_PUBLIC_BASE_URL: `http://127.0.0.1:${port}` } });
    const { session, agent, publicId } = await openA2aAgent(ctx);
    await ctx.dependencies.routineDefinitionService.createDraft(session.workspaceId, agent.id, supportIntakeDraft());
    server = ctx.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));

    // No Radioso code from here on: the client finds the endpoint in the card.
    const client = await new ClientFactory().createFromUrl(`http://127.0.0.1:${port}/.well-known/agent-card/${publicId}.json`, "");

    const started = asTask(await client.sendMessage(textMessage("I need support intake")));
    expect(started.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(started.status?.message?.parts[0]?.content).toMatchObject({ $case: "text" });

    const completed = asTask(await client.sendMessage(textMessage("topic: billing", { contextId: started.contextId, taskId: started.id })));
    expect(completed.id).toBe(started.id);
    expect(completed.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(completed.artifacts).toHaveLength(1);

    const read = await client.getTask({ tenant: "", id: started.id, historyLength: undefined });
    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});
