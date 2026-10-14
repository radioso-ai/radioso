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

    expect(created.voice).toEqual({ enabled: false, bridgeLines: {}, fallbackLine: {} });
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
