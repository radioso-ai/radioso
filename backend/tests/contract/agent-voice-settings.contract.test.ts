import request from "supertest";
import { describe, expect, it } from "vitest";

import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const voice = {
  enabled: true,
  bridgeLines: {
    en: { acknowledge: ["Got it."], check: ["Let me check that for you."] },
    it: { acknowledge: ["Perfetto."], check: ["Controllo subito."] },
  },
  fallbackLine: {
    en: "Sorry, that is taking longer than it should. Could you ask me again?",
    it: "Scusa, ci sto mettendo troppo. Puoi ripetere la domanda?",
  },
  runtime: { vendor: "elevenlabs", agentId: "agent_01jxk2v9qbe8n7r6t5w4" },
};

const agentWithToken = async (email: string) => {
  const { app } = createTestApp();
  const { token, cookie, workspaceId } = await issueTestToken(app, email);
  const authorization = `Bearer ${token}`;
  const created = await request(app)
    .post("/api/v1/agents")
    .set("Authorization", authorization)
    .send({ name: "Voice agent" })
    .expect(201);
  return {
    app,
    authorization,
    dashboard: adminSessionHeaders({ cookie, workspaceId }),
    agentId: created.body.id as string,
    created: created.body as Record<string, unknown>,
  };
};

describe("agent voice settings contract", () => {
  it("starts an agent with voice off and nothing authored", async () => {
    const { created } = await agentWithToken("agent-voice-default@example.com");

    expect(created.voice).toEqual({ enabled: false, bridgeLines: {}, fallbackLine: {}, runtime: null });
  });

  it("round-trips the voice block through the agent settings API", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-voice-round-trip@example.com");

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ voice })
      .expect(200);
    const refetched = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(updated.body.voice).toEqual(voice);
    expect(refetched.body.voice).toEqual(voice);
  });

  it("stores a block written without runtime as bound to no vendor agent", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-voice-without-runtime@example.com");
    const { runtime: _runtime, ...withoutRuntime } = voice;

    const updated = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ voice: withoutRuntime })
      .expect(200);

    expect(updated.body.voice).toEqual({ ...withoutRuntime, runtime: null });
  });

  it("refuses a voice block carrying a key it does not name, naming the key", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-voice-extra-key@example.com");

    const refused = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ voice: { ...voice, apiKey: "xi-secret-0123456789" } })
      .expect(400);

    expect(JSON.stringify(refused.body.error)).toContain("apiKey");
    expect(JSON.stringify(refused.body)).not.toContain("xi-secret-0123456789");
  });

  it("keeps the voice block when a dashboard save sends the other settings without it", async () => {
    const { app, authorization, dashboard, agentId } = await agentWithToken("agent-voice-dashboard-save@example.com");
    await request(app).put(`/api/v1/agents/${agentId}`).set("Authorization", authorization).send({ voice }).expect(200);

    // The dashboard's General settings and Behavior saves send their own fields and nothing else.
    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(dashboard)
      .send({
        name: "Renamed voice agent",
        internalName: "",
        greetingInstruction: "Greet briefly.",
        assistantDefaultLocale: "it",
        proactiveGreetingEnabled: false,
        surfaceSettings: { authenticatedChat: { enabled: true }, anonymousChat: { enabled: false } },
      })
      .expect(200);
    const saved = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set(dashboard)
      .send({ citationDisplayEnabled: false, theme: { brand: "#123456" } })
      .expect(200);

    expect(saved.body.name).toBe("Renamed voice agent");
    expect(saved.body.voice).toEqual(voice);
  });

  it("refuses an invalid or partial block and leaves the stored one as it was", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-voice-invalid@example.com");
    await request(app).put(`/api/v1/agents/${agentId}`).set("Authorization", authorization).send({ voice }).expect(200);

    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ voice: { ...voice, bridgeLines: { en: { acknowledge: [], check: ["1", "2", "3", "4", "5", "6"] } } } })
      .expect(400);
    await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ voice: { enabled: false } })
      .expect(400);
    const refetched = await request(app)
      .get(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(refetched.body.voice).toEqual(voice);
  });
});

const mechanicsReplies = {
  en: { greeting: ["Hi! How can I help?"], thanks: ["You are welcome!"], farewell: [], acknowledgement: [] },
};

describe("agent mechanics replies contract", () => {
  it("clears the block with an explicit empty one", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-mechanics-clear@example.com");
    await request(app).put(`/api/v1/agents/${agentId}`).set("Authorization", authorization).send({ mechanicsReplies }).expect(200);

    const cleared = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ mechanicsReplies: {} })
      .expect(200);
    const refetched = await request(app).get(`/api/v1/agents/${agentId}`).set("Authorization", authorization).expect(200);

    expect(cleared.body.mechanicsReplies).toEqual({});
    expect(refetched.body.mechanicsReplies).toEqual({});
  });

  it("keeps the block when an update leaves it out", async () => {
    const { app, authorization, agentId } = await agentWithToken("agent-mechanics-omitted@example.com");
    await request(app).put(`/api/v1/agents/${agentId}`).set("Authorization", authorization).send({ mechanicsReplies }).expect(200);

    // The Voice card sends both blocks; every other save sends neither.
    await request(app).put(`/api/v1/agents/${agentId}`).set("Authorization", authorization).send({ voice }).expect(200);
    const saved = await request(app)
      .put(`/api/v1/agents/${agentId}`)
      .set("Authorization", authorization)
      .send({ citationDisplayEnabled: false })
      .expect(200);

    expect(saved.body.mechanicsReplies).toEqual(mechanicsReplies);
    expect(saved.body.voice).toEqual(voice);
  });
});
