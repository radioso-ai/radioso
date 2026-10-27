import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../../src/app/config/env.js";
import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const VENDOR_KEY = "xi-workspace-secret-0123456789";
const PUBLIC_API = "https://api.radioso.test";
const EU = "https://api.eu.residency.elevenlabs.io";
const csrf = { "X-Radioso-CSRF": "1" };

type VendorFetch = typeof globalThis.fetch;
interface VendorCall {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const invalidKeyOnOtherHost = () => json(400, { detail: { type: "authentication_error", code: "invalid_api_key" } });

/**
 * ElevenLabs as a small in-memory account on the EU residency host: probes, secrets and agents,
 * with each agent document kept so a read after a write sees the write.
 */
const fakeElevenLabs = (options: { probe?: () => Response } = {}) => {
  const calls: VendorCall[] = [];
  const agents = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, string>();
  let counter = 0;
  const fetch = vi.fn<VendorFetch>(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/v1/convai/agents?page_size=1")) {
      if (options.probe) return url.startsWith(EU) ? options.probe() : invalidKeyOnOtherHost();
      return url.startsWith(EU) ? json(200, { agents: [], next_cursor: null }) : invalidKeyOnOtherHost();
    }
    if (!url.startsWith(EU)) return invalidKeyOnOtherHost();
    const path = url.slice(EU.length);
    if (method === "POST" && path === "/v1/convai/secrets") {
      counter += 1;
      const secretId = `sec_${counter}`;
      secrets.set(secretId, String(body?.value));
      return json(200, { type: "stored", secret_id: secretId, name: body?.name });
    }
    if (method === "DELETE" && path.startsWith("/v1/convai/secrets/")) {
      secrets.delete(path.split("/").at(-1)!);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/v1/convai/agents/create") {
      counter += 1;
      const agentId = `agent_${counter}`;
      agents.set(agentId, { agent_id: agentId, ...body });
      return json(200, { agent_id: agentId });
    }
    const agentId = path.startsWith("/v1/convai/agents/") ? path.split("/").at(-1)! : null;
    const stored = agentId ? agents.get(agentId) : undefined;
    if (!agentId || !stored) return json(404, { detail: { type: "not_found", code: "agent_not_found" } });
    if (method === "GET") return json(200, stored);
    if (method === "PATCH") {
      const config = { ...(stored.conversation_config as object), ...(body?.conversation_config as object) };
      agents.set(agentId, { ...stored, ...body, conversation_config: config });
      return json(200, { agent_id: agentId });
    }
    if (method === "DELETE") {
      agents.delete(agentId);
      return new Response(null, { status: 204 });
    }
    return json(405, {});
  });
  const secretOf = (agentId: string): string | undefined => {
    const config = agents.get(agentId)?.conversation_config as { agent: { prompt: { custom_llm: { api_key: { secret_id: string } } } } } | undefined;
    const secretId = config?.agent.prompt.custom_llm.api_key.secret_id;
    return secretId ? secrets.get(secretId) : undefined;
  };
  return { fetch, calls, agents, secrets, secretOf };
};

const operatorWith = async (options: { vendor?: ReturnType<typeof fakeElevenLabs>; vendorKey?: string | null; envOverrides?: Partial<Env> } = {}) => {
  const vendor = options.vendor ?? fakeElevenLabs();
  const { app } = createTestApp({
    voiceVendorFetch: vendor.fetch,
    envOverrides: { PUBLIC_API_BASE_URL: PUBLIC_API, ...options.envOverrides },
  });
  const operator = await issueTestToken(app, `voice-connection-${randomUUID()}@example.com`);
  const dashboard = adminSessionHeaders(operator);
  const agents = await request(app).get("/api/v1/agents").set(dashboard).expect(200);
  const agentId = (agents.body.agents as Array<{ id: string; isDefault: boolean }>).find((agent) => agent.isDefault)!.id;
  const vendorKey = options.vendorKey === undefined ? VENDOR_KEY : options.vendorKey;
  if (vendorKey) await request(app).put("/api/v1/settings/credentials/elevenlabs").set(dashboard).send({ apiKey: vendorKey }).expect(204);
  const connection = `/api/v1/agents/${agentId}/voice/connection`;
  return {
    app,
    vendor,
    dashboard,
    bearer: { Authorization: `Bearer ${operator.token}`, "X-Workspace-Id": operator.workspaceId },
    agentId,
    connection,
    connect: () => request(app).post(connection).set({ ...dashboard, ...csrf }),
    disconnect: () => request(app).delete(connection).set({ ...dashboard, ...csrf }),
    status: () => request(app).get(connection).set(dashboard),
    agent: async () => (await request(app).get(`/api/v1/agents/${agentId}`).set(dashboard).expect(200)).body as { voice: { runtime: unknown } },
    restCredentials: async () => (await request(app).get(`/api/v1/agents/${agentId}/channel-credentials?audience=rest`).set(dashboard).expect(200))
      .body.credentials as Array<{ id: string; label: string; prefix: string; status: string; expiresAt: string | null }>,
  };
};

describe("agent voice connection contract", () => {
  it("reads an agent with no runtime as not connected, naming whether the key is stored", async () => {
    const { status } = await operatorWith({ vendorKey: null });

    expect((await status().expect(200)).body).toEqual({
      vendor: "elevenlabs",
      state: "not_connected",
      region: null,
      vendorKey: "missing",
      connectAvailable: true,
      runtime: null,
    });
  });

  it("creates the ElevenLabs agent in the key's region, gives it a REST credential of its own, and binds it", async () => {
    const { connect, vendor, agent, agentId, restCredentials, status } = await operatorWith();

    const connected = await connect().expect(200);

    const runtime = { vendor: "elevenlabs", agentId: "agent_2", region: "eu" };
    expect(connected.body).toEqual({ vendor: "elevenlabs", state: "connected", region: "eu", vendorKey: "stored", connectAvailable: true, runtime });
    expect((await agent()).voice.runtime).toEqual(runtime);
    expect((await status().expect(200)).body.state).toBe("connected");
    const created = vendor.agents.get("agent_2") as { conversation_config: { agent: { prompt: { custom_llm: { url: string } } } } };
    expect(created.conversation_config.agent.prompt.custom_llm.url).toBe(`${PUBLIC_API}/api/v1/agents/${agentId}/voice/elevenlabs/v1`);
    const credentials = await restCredentials();
    expect(credentials).toEqual([expect.objectContaining({ label: "Voice calls", status: "active", expiresAt: null })]);
    expect(vendor.secretOf("agent_2")?.startsWith(credentials[0].prefix)).toBe(true);
  });

  it("repairs on a second Connect without minting another credential", async () => {
    const { connect, vendor, restCredentials } = await operatorWith();
    await connect().expect(200);
    const [credential] = await restCredentials();
    vendor.calls.length = 0;

    const again = await connect().expect(200);

    expect(again.body.runtime).toEqual({ vendor: "elevenlabs", agentId: "agent_2", region: "eu" });
    expect(vendor.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url.replace(EU, "")}`)).toEqual(["PATCH /v1/convai/agents/agent_2"]);
    expect(await restCredentials()).toEqual([credential]);
  });

  it("gives the vendor agent a new credential on Connect after the operator revoked its own on the API card", async () => {
    const { app, dashboard, agentId, connect, vendor, restCredentials } = await operatorWith();
    await connect().expect(200);
    const [revoked] = await restCredentials();
    await request(app).post(`/api/v1/agents/${agentId}/channel-credentials/${revoked.id}/revoke`).set({ ...dashboard, ...csrf }).expect(204);

    await connect().expect(200);

    const [replacement] = await restCredentials();
    expect(replacement.id).not.toBe(revoked.id);
    expect(vendor.secretOf("agent_2")?.startsWith(replacement.prefix)).toBe(true);
  });

  it("binds the same vendor agent again after a save that sent no runtime cleared the binding", async () => {
    const { app, dashboard, agentId, connect, status } = await operatorWith();
    await connect().expect(200);
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ voice: { enabled: true, bridgeLines: {}, fallbackLine: {} } }).expect(200);
    expect((await status().expect(200)).body.state).toBe("not_connected");

    const repaired = await connect().expect(200);

    expect(repaired.body).toMatchObject({ state: "connected", runtime: { agentId: "agent_2" } });
  });

  it("disconnects by deleting the vendor agent and its secret, revoking the credential, and unbinding", async () => {
    const { connect, disconnect, vendor, agent, restCredentials } = await operatorWith();
    await connect().expect(200);

    const disconnected = await disconnect().expect(200);

    expect(disconnected.body).toEqual({
      vendor: "elevenlabs",
      state: "not_connected",
      region: null,
      vendorKey: "stored",
      connectAvailable: true,
      runtime: null,
      vendorAgentLeft: false,
    });
    expect(vendor.agents.size).toBe(0);
    expect(vendor.secrets.size).toBe(0);
    expect((await agent()).voice.runtime).toBeNull();
    expect(await restCredentials()).toEqual([]);
  });

  it("only unbinds a runtime the operator bound by hand, and never touches their ElevenLabs agent", async () => {
    const { app, dashboard, agentId, disconnect, status, vendor } = await operatorWith();
    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({
      voice: { enabled: true, bridgeLines: {}, fallbackLine: {}, runtime: { vendor: "elevenlabs", agentId: "agent_theirs", region: "us" } },
    }).expect(200);

    expect((await status().expect(200)).body).toMatchObject({ state: "connected_externally", region: "us" });
    expect((await disconnect().expect(200)).body).toMatchObject({ state: "not_connected", vendorAgentLeft: false });
    expect(vendor.calls).toEqual([]);
  });

  it("keeps the vendor agent's language in step with the agent's default locale", async () => {
    const { app, dashboard, agentId, connect, vendor } = await operatorWith();
    await connect().expect(200);

    await request(app).put(`/api/v1/agents/${agentId}`).set(dashboard).send({ assistantDefaultLocale: "pt-BR" }).expect(200);

    await vi.waitFor(() => {
      const config = vendor.agents.get("agent_2")?.conversation_config as { agent: { language: string } };
      expect(config.agent.language).toBe("pt-br");
    });
  });

  it("deletes the vendor agent Radioso created when its agent is deleted, after the deletion answers", async () => {
    const { app, dashboard, vendor } = await operatorWith();
    const second = await request(app).post("/api/v1/agents").set(dashboard).send({ name: "Second" }).expect(201);
    await request(app).post(`/api/v1/agents/${second.body.id}/voice/connection`).set({ ...dashboard, ...csrf }).expect(200);
    expect(vendor.agents.size).toBe(1);

    await request(app).delete(`/api/v1/agents/${second.body.id}`).set(dashboard).expect(204);

    // The deletion answers without waiting on ElevenLabs; the vendor agent goes right after.
    await vi.waitFor(() => expect(vendor.agents.size).toBe(0));
  });

  it.each([
    ["no key is stored", { vendorKey: null }, 409, "voice_vendor_key_missing"],
    ["the deployment has no public API origin", { envOverrides: { PUBLIC_API_BASE_URL: undefined } }, 503, "voice_connection_unavailable"],
    ["ElevenLabs rejects the key", { vendor: fakeElevenLabs({ probe: () => json(401, { detail: { code: "invalid_api_key" } }) }) }, 422, "voice_vendor_key_rejected"],
    [
      "the key may not manage agents",
      { vendor: fakeElevenLabs({ probe: () => json(401, { detail: { status: "missing_permissions", message: "missing convai_read" } }) }) },
      422,
      "voice_vendor_key_lacks_agents_permission",
    ],
    ["ElevenLabs is down", { vendor: fakeElevenLabs({ probe: () => new Response(null, { status: 503 }) }) }, 503, "voice_vendor_unreachable"],
  ] as const)("refuses to connect when %s, and binds nothing", async (_label, options, status, code) => {
    const { connect, agent, restCredentials } = await operatorWith(options);

    const refused = await connect().expect(status);

    expect(refused.body.error.code).toBe(code);
    expect(JSON.stringify(refused.body)).not.toContain(VENDOR_KEY);
    expect((await agent()).voice.runtime).toBeNull();
    expect(await restCredentials()).toEqual([]);
  });

  it("asks for the CSRF header on Connect and Disconnect", async () => {
    const { app, dashboard, connection } = await operatorWith();

    await request(app).post(connection).set(dashboard).expect(403);
    await request(app).delete(connection).set(dashboard).expect(403);
  });

  it("is for dashboard sessions only: an API token is not a session", async () => {
    const { app, bearer, connection } = await operatorWith();

    await request(app).get(connection).set(bearer).expect(401);
    await request(app).post(connection).set({ ...bearer, ...csrf }).expect(401);
  });

  it("answers 404 for an agent that does not exist", async () => {
    const { app, dashboard } = await operatorWith();

    await request(app).get(`/api/v1/agents/${randomUUID()}/voice/connection`).set(dashboard).expect(404);
  });
});
