import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import { RESPONSE_INTENT, REWRITE_TURN_KIND } from "../../src/modules/retrieval/domain/retrievalPipelineTypes.js";
import { adminSessionHeaders, createTestApp, issueTestToken } from "../support/testApp.js";

const parseSseData = (body: string, eventName: string): unknown[] =>
  body
    .split("\n\n")
    .filter((block) => block.includes(`event: ${eventName}\n`))
    .map((block) => {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) {
        throw new Error(`Missing data line for ${eventName}`);
      }
      return JSON.parse(dataLine.slice("data: ".length));
    });

describe("agents contract", () => {
  it("creates a default agent and preserves omitted agentId chat compatibility", async () => {
    const chatGateway: ChatGateway = {
      async answer({ query }) {
        return `answer:${query}`;
      },
      async *streamAnswer({ query }) {
        yield `answer:${query}`;
      },
    };
    const { app } = createTestApp({ chatGateway });
    const { token } = await issueTestToken(app, "agents-default@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);

    expect(list.body.agents).toHaveLength(1);
    expect(list.body.agents[0]).toMatchObject({
      id: expect.any(String),
      isDefault: true,
      retrievalEnabled: true,
      surfaceSettings: {
        authenticatedChat: { enabled: true },
        anonymousChat: { enabled: false },
      },
    });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "hello", stream: false })
      .expect(200);

    expect(chat.body).toMatchObject({
      agentId: list.body.agents[0].id,
      agentName: list.body.agents[0].name,
      answer: expect.any(String),
    });
  });

  it("routes explicit agents and rejects agents from another workspace", async () => {
    const { app } = createTestApp({
      lexicalSearch: {
        async search() {
          throw new Error("direct-only agent should not invoke retrieval search");
        },
      },
    });
    const first = await issueTestToken(app, "agents-first@example.com");
    const second = await issueTestToken(app, "agents-second@example.com");
    const firstAuthorization = `Bearer ${first.token}`;
    const secondAuthorization = `Bearer ${second.token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", firstAuthorization)
      .send({
        name: "Direct agent",
        customInstruction: "Answer without retrieval.",
        retrievalEnabled: false,
      })
      .expect(201);

    expect(agent.body).toMatchObject({
      retrievalEnabled: false,
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
        },
      },
    });

    const chat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", firstAuthorization)
      .send({ agentId: agent.body.id, message: "hello direct", stream: false })
      .expect(200);

    expect(chat.body).toMatchObject({
      agentId: agent.body.id,
      agentName: "Direct agent",
      retrievalInfo: expect.objectContaining({
        retrievalSkipped: true,
      }),
    });
    expect(chat.body.citations ?? []).toEqual([]);
    expect(chat.body.retrievalInfo.candidateCounts).toMatchObject({
      semantic: 0,
      lexical: 0,
      final: 0,
    });

    await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", secondAuthorization)
      .send({ agentId: agent.body.id, message: "cross workspace", stream: false })
      .expect(404);
  });

  it("streams explicit agent identity and keeps the selected agent in the SSE done event", async () => {
    let observedPrompt = "";
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            responseIntent: RESPONSE_INTENT.ASSISTANT_IDENTITY,
            turnKind: REWRITE_TURN_KIND.FRESH_SUBJECT,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.99,
          };
        },
      },
      chatGateway: {
        async answer(input) {
          observedPrompt = input.prompt;
          return "I am Balaram.";
        },
        async *streamAnswer() {
          throw new Error("non-retrieval agent identity should use the direct answer path");
        },
      },
    });
    const { token } = await issueTestToken(app, "agents-streaming-identity@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Balaram",
        customInstruction: "You are Balaram, the course guide.",
      })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => callback(null, body));
      })
      .send({ agentId: agent.body.id, message: "who are you?", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('data: {"text":"I am Balaram."}');
    expect(observedPrompt).toContain("Response identity name: Balaram");
    expect(observedPrompt).toContain("You are Balaram, the course guide.");

    const [done] = parseSseData(response.body, "done");
    expect(done).toMatchObject({
      agentId: agent.body.id,
      agentName: "Balaram",
      answer: "I am Balaram.",
      route: {
        type: "direct",
        reason: "assistant_identity",
      },
    });
  });

  it("keeps legacy settings scoped to the default agent", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "agents-legacy-default@example.com");
    const authorization = `Bearer ${session.token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Side agent",
      })
      .expect(201);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        assistantName: "Default support",
        anonymousChatEnabled: true,
      })
      .expect(200);

    const defaultAgent = await request(app)
      .get(`/api/v1/agents/${defaultAgentId}`)
      .set("Authorization", authorization)
      .expect(200);
    const unchangedSideAgent = await request(app)
      .get(`/api/v1/agents/${sideAgent.body.id}`)
      .set("Authorization", authorization)
      .expect(200);

    expect(defaultAgent.body).toMatchObject({
      name: "Default support",
      surfaceSettings: {
        anonymousChat: {
          enabled: true,
        },
      },
    });
    expect(unchangedSideAgent.body).toMatchObject({
      name: "Side agent",
      surfaceSettings: {
        anonymousChat: {
          enabled: false,
          token: null,
        },
      },
    });
  });

  it("keeps per-agent public surface tokens isolated", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-surface-tokens@example.com");
    const authorization = `Bearer ${token}`;

    const list = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const defaultAgentId = list.body.agents[0].id as string;

    await request(app)
      .put(`/api/v1/agents/${defaultAgentId}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://default.example.com"],
          },
        },
      })
      .expect(200);
    const defaultAnonymousToken = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const defaultEmbedToken = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);

    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Embed side agent" })
      .expect(201);
    const updatedSideAgent = await request(app)
      .put(`/api/v1/agents/${sideAgent.body.id}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
          websiteEmbed: {
            enabled: true,
            allowedOrigins: ["https://side.example.com"],
          },
        },
      })
      .expect(200);
    const sideAnonymousToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const sideEmbedToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/website-embed-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);

    expect(sideAnonymousToken.body.surfaceSettings.anonymousChat.token).not.toBe(defaultAnonymousToken.body.surfaceSettings.anonymousChat.token);
    expect(sideEmbedToken.body.surfaceSettings.websiteEmbed.token).not.toBe(defaultEmbedToken.body.surfaceSettings.websiteEmbed.token);

    const embedToken = sideEmbedToken.body.surfaceSettings.websiteEmbed.token as string;
    const publicSession = await request(app)
      .post(`/api/v1/public/chat/${embedToken}/sessions`)
      .set("Origin", "https://side.example.com")
      .send({ channel: "website_embed" })
      .expect(200);

    expect(publicSession.body).toMatchObject({
      agentId: updatedSideAgent.body.id,
      publicChatToken: embedToken,
    });

    await request(app)
      .post(`/api/v1/public/chat/${publicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "hello side agent", stream: false })
      .expect(200);
  });

  it("rejects enabled website embed settings without an allowed origin", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "agents-embed-validation@example.com");
    const authorization = `Bearer ${token}`;

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Embed validation agent" })
      .expect(201);

    await request(app)
      .put(`/api/v1/agents/${agent.body.id}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          websiteEmbed: {
            enabled: true,
            allowedOrigins: [],
          },
        },
      })
      .expect(400);
  });
});
