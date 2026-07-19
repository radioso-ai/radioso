import { describe, expect, it, vi } from "vitest";

import { createRadiosoClient } from "../../src/index.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeClient = (impl: () => Promise<Response>) => {
  const fetchMock = vi.fn(impl);
  const client = createRadiosoClient({
    baseUrl: "https://api.example.com",
    apiToken: "token-123",
    fetch: fetchMock as typeof fetch,
  });
  return { client, fetchMock };
};

const lastRequest = (fetchMock: ReturnType<typeof vi.fn>) => {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit] | undefined;
  if (!call) {
    throw new Error("Expected a fetch call.");
  }
  return { url: call[0], init: call[1] };
};

describe("authoring resources", () => {
  it("targets the agent-scoped routine authoring routes with bearer auth", async () => {
    const { client, fetchMock } = makeClient(async () => jsonResponse({ routines: [] }));

    await client.agents.routines.list("agent-1");

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/agents/agent-1/routines");
    expect(init.method).toBe("GET");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer token-123");
  });

  it("publishes a routine via POST to the lifecycle route", async () => {
    const { client, fetchMock } = makeClient(async () => jsonResponse({ routine: { id: "r1" } }));

    await client.agents.routines.publish("agent-1", "r1");

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/agents/agent-1/routines/r1/publish");
    expect(init.method).toBe("POST");
  });

  it("round-trips a portable routine document through PUT", async () => {
    const envelope = { grammarVersion: 1, content: "# Routine" };
    const { client, fetchMock } = makeClient(async () => jsonResponse(envelope));

    await client.agents.routines.updatePortable("agent-1", "r1", envelope);

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/agents/agent-1/routines/r1/portable");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify(envelope));
  });

  it("canonicalizes a portable document at the workspace-scoped route", async () => {
    const envelope = { grammarVersion: 1, content: "# Routine" };
    const { client, fetchMock } = makeClient(async () => jsonResponse(envelope));

    await client.routines.canonicalizePortable(envelope);

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/routines/portable/canonicalize");
    expect(init.method).toBe("POST");
  });

  it("creates a directive under the agent directives route", async () => {
    const { client, fetchMock } = makeClient(async () => jsonResponse({ directive: { id: "d1" } }, 201));

    await client.agents.directives.create("agent-1", {
      name: "Escalate refunds",
      condition: { kind: "contextual", description: "the customer asks for a refund" },
      action: "Offer to connect them with a human agent.",
    });

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/agents/agent-1/directives");
    expect(init.method).toBe("POST");
  });

  it("supports the documented context-variable authoring flow", async () => {
    const { client, fetchMock } = makeClient(async () =>
      jsonResponse({ contextVariable: { id: "cv1" }, value: { id: "value1" }, enablement: {} }),
    );

    const { contextVariable } = await client.contextVariables.create({
      name: "plan_tier",
      description: "The visitor's current plan",
      valueType: "string",
      trustTier: "unverified",
      sensitivity: "normal",
      defaultSurfacing: "always",
    });
    await client.contextVariables.upsertValue(contextVariable.id, {
      scope: { type: "customer", id: "c-9" },
      data: "pro",
    });
    await client.agents.contextVariables.upsert("agent-1", contextVariable.id, {
      source: "pushed",
      surfacing: "always",
      enabled: true,
    });

    const [, upsertValueCall, enableCall] = fetchMock.mock.calls as [string, RequestInit][];
    expect(upsertValueCall[0]).toBe("https://api.example.com/api/v1/context-variables/cv1/values");
    expect(upsertValueCall[1].method).toBe("PUT");
    expect(upsertValueCall[1].body).toBe(
      JSON.stringify({ scope: { type: "customer", id: "c-9" }, data: "pro" }),
    );
    expect(enableCall[0]).toBe("https://api.example.com/api/v1/agents/agent-1/context-variables/cv1");
    expect(enableCall[1].body).toBe(
      JSON.stringify({ source: "pushed", surfacing: "always", enabled: true }),
    );
  });

  it("passes scope query params when reading a context-variable value", async () => {
    const { client, fetchMock } = makeClient(async () => jsonResponse({ value: null }));

    await client.contextVariables.getValue("cv1", { scopeType: "customer", scopeId: "c-9" });

    const { url } = lastRequest(fetchMock);
    expect(url).toBe(
      "https://api.example.com/api/v1/context-variables/cv1/values?scopeType=customer&scopeId=c-9",
    );
  });

  it("upserts an agent context-variable enablement via PUT", async () => {
    const { client, fetchMock } = makeClient(async () => jsonResponse({ enablement: {} }));

    await client.agents.contextVariables.upsert("agent-1", "cv1", {
      source: "pushed",
      surfacing: "always",
      enabled: true,
    });

    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.example.com/api/v1/agents/agent-1/context-variables/cv1");
    expect(init.method).toBe("PUT");
  });

  it("wires each T2 skill-config family to its route", async () => {
    const cases: Array<[Promise<unknown>, string]> = [];
    const { client, fetchMock } = makeClient(async () => jsonResponse({ skills: [] }));

    await client.agents.skills.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/skills"]);
    await client.agents.emailSkills.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/email-skills"]);
    await client.agents.externalSkills.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/external-skills"]);
    await client.agents.webhookSkills.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/webhook-skills"]);
    await client.agents.slackSkills.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/slack-skills"]);
    await client.agents.mcpConnections.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/mcp-connections"]);
    await client.agents.mcpConverseGrants.list("a1");
    cases.push([Promise.resolve(), "/api/v1/agents/a1/mcp-converse-grants"]);

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    for (const [, expectedPath] of cases) {
      expect(urls).toContain(`https://api.example.com${expectedPath}`);
    }
  });

  it("returns undefined for 204 deletes", async () => {
    const { client } = makeClient(async () => jsonResponse(null, 204));

    await expect(client.agents.routines.delete("a1", "r1")).resolves.toBeUndefined();
    await expect(client.agents.directives.delete("a1", "d1")).resolves.toBeUndefined();
    await expect(client.agents.webhookSkills.delete("a1", "s1")).resolves.toBeUndefined();
  });
});
