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

  it("exposes HTTP authoring CRUD and applies created directives on the next turn", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt }) => ({
        text: "authored:http",
        metadata: {
          sawDirective: systemPrompt?.includes("Say portable persistence is enabled.") ?? false,
        },
      })),
    };
    const server = createConversationKitServer({ kitOptions: { modelGateway: gateway } });
    servers.push(server);
    const address = await server.listen({ port: 0, host: "127.0.0.1" });

    const agentResponse = await fetch(`${address.url}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent_authored", name: "Authored Agent" }),
    });
    expect(agentResponse.status).toBe(201);

    const updateAgentResponse = await fetch(`${address.url}/agents/agent_authored`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated Authored Agent" }),
    });
    expect(updateAgentResponse.status).toBe(200);
    await expect(updateAgentResponse.json()).resolves.toMatchObject({
      agent: { id: "agent_authored", name: "Updated Authored Agent" },
    });

    const directiveResponse = await fetch(`${address.url}/agents/agent_authored/directives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "directive_persistence",
        name: "persistence",
        condition: { kind: "always" },
        action: "Say portable persistence is enabled.",
      }),
    });
    expect(directiveResponse.status).toBe(201);

    const updateDirectiveResponse = await fetch(`${address.url}/agents/agent_authored/directives/directive_persistence`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "persistence",
        condition: { kind: "always" },
        action: "Say portable persistence is enabled.",
        priority: 2,
      }),
    });
    expect(updateDirectiveResponse.status).toBe(200);

    const listResponse = await fetch(`${address.url}/agents/agent_authored/directives`);
    await expect(listResponse.json()).resolves.toMatchObject({
      directives: [{ id: "directive_persistence", action: "Say portable persistence is enabled." }],
    });

    const routine = {
      id: "routine_authored",
      rootStepId: "start",
      steps: [
        { id: "start", kind: "chat", action: "Ask for the user's email." },
        { id: "done", kind: "terminal", action: "Confirm capture." },
      ],
      transitions: [{ from: "start", to: "done", condition: "email collected" }],
    };
    const createRoutineResponse = await fetch(`${address.url}/routines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(routine),
    });
    expect(createRoutineResponse.status).toBe(201);

    const updateRoutineResponse = await fetch(`${address.url}/routines/routine_authored`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...routine, metadata: { version: 2 } }),
    });
    expect(updateRoutineResponse.status).toBe(200);
    await expect(updateRoutineResponse.json()).resolves.toMatchObject({
      routine: { id: "routine_authored", metadata: { version: 2 } },
    });

    const turnResponse = await fetch(`${address.url}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "agent_authored",
        sessionId: "session_authored",
        message: "Does the new directive apply?",
      }),
    });

    expect(turnResponse.status).toBe(200);
    await expect(turnResponse.json()).resolves.toMatchObject({
      sessionId: "session_authored",
      reply: {
        answer: "authored:http",
        metadata: { sawDirective: true },
      },
    });

    const deleteResponse = await fetch(`${address.url}/agents/agent_authored/directives/directive_persistence`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(204);

    const deleteRoutineResponse = await fetch(`${address.url}/routines/routine_authored`, {
      method: "DELETE",
    });
    expect(deleteRoutineResponse.status).toBe(204);
  });

  it("rejects conflicting authored directives over HTTP when coherence is enabled", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          verdict: "conflict",
          conflicts: [{
            directiveId: "directive_formal",
            directiveName: "formal-greeting",
            reason: "The candidate forbids the greeting behavior that the existing directive requires.",
          }],
          rationale: "The candidate contradicts an active greeting directive.",
        }),
      })),
    };
    const server = createConversationKitServer({
      kitOptions: {
        modelGateway: gateway,
        directiveCoherence: { enabled: true },
      },
    });
    servers.push(server);
    const address = await server.listen({ port: 0, host: "127.0.0.1" });

    const agentResponse = await fetch(`${address.url}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "agent_coherent", name: "Coherent Agent" }),
    });
    expect(agentResponse.status).toBe(201);

    const existingResponse = await fetch(`${address.url}/agents/agent_coherent/directives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "directive_formal",
        name: "formal-greeting",
        condition: { kind: "always" },
        action: "Always greet formally.",
      }),
    });
    expect(existingResponse.status).toBe(201);

    const conflictResponse = await fetch(`${address.url}/agents/agent_coherent/directives`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "directive_terse",
        name: "terse-no-greeting",
        condition: { kind: "always" },
        action: "Never greet; be terse.",
      }),
    });

    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toMatchObject({
      error: "conversation_kit_directive_coherence_conflict",
      coherent: false,
      conflicts: [{
        directiveId: "directive_formal",
        directiveName: "formal-greeting",
      }],
      rationale: "The candidate contradicts an active greeting directive.",
    });

    const listResponse = await fetch(`${address.url}/agents/agent_coherent/directives`);
    await expect(listResponse.json()).resolves.toMatchObject({
      directives: [{ id: "directive_formal" }],
    });
  });
});
