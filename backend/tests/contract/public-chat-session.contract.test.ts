import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";

import { issuePublicChatSession } from "../../src/modules/settings/contracts/publicChatSession.js";
import type { ChatIntakeProviderPort } from "../../src/modules/chat/services/chatIntakeProvider.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

describe("public chat session contract", () => {
  const enableWebsiteEmbed = async (app: any, session: { cookie: string; workspaceId: string }) => {
    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
        websiteEmbedLauncherLabel: "Talk to us",
      });

    return response.body.websiteEmbedToken as string;
  };

  const createWebsiteEmbedPublicSession = (app: any, token: string, origin = "https://example.com", body = {}) =>
    request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .set("Origin", origin)
      .send({ channel: "website_embed", ...body });

  it("creates a website embed session for an approved origin", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-approved@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      workspaceName: expect.any(String),
      publicChatToken: token,
      publicSessionId: expect.any(String),
      publicSessionToken: expect.any(String),
      assistantBootstrapActive: false,
    });
    expect(response.body.expiresAt).toEqual(expect.any(String));
  });

  it("exposes configured public intake actions on website embed sessions and conversation lists", async () => {
    const chatIntakeProvider: ChatIntakeProviderPort = {
      async handle() {
        return null;
      },
      async getPublicIntakeActions(input) {
        expect(input.sourceChannel).toBe("website_embed");
        return [{
          skillName: "human_contact.request",
          intentName: "explicit_contact_request",
        }];
      },
    };
    const { app } = createTestApp({ chatIntakeProvider });
    const session = await issueTestSession(app, "public-embed-intake-actions@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const publicSession = await createWebsiteEmbedPublicSession(app, token);

    expect(publicSession.status).toBe(200);
    expect(publicSession.body.intakeActions).toEqual([
      {
        skillName: "human_contact.request",
        intentName: "explicit_contact_request",
      },
    ]);

    const conversations = await request(app)
      .get(`/api/v1/public/chat/${publicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken);

    expect(conversations.status).toBe(200);
    expect(conversations.body.intakeActions).toEqual(publicSession.body.intakeActions);
  });

  it("returns 503 when website embed secret is unset", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_SECRET: undefined,
      },
    });
    const session = await issueTestSession(app, "public-embed-missing-secret@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";
    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "service_unavailable",
      message: "Public chat sessions are not configured.",
    });
  });

  it("uses the workspace token secret as a development-only public session fallback", async () => {
    const { app } = createTestApp({
      envOverrides: {
        NODE_ENV: "development",
        PUBLIC_CHAT_SESSION_SECRET: undefined,
        WORKSPACE_TOKEN_SECRET: "development-workspace-token-secret",
      },
    });
    const session = await issueTestSession(app, "public-embed-dev-fallback@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";
    const publicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(publicSession.status).toBe(200);

    const chatResponse = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(chatResponse.status).toBe(200);
  });

  it("rejects an unapproved origin", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-embed-denied@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://not-approved.example.com";

    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
    });

    const auditEvents = (dependencies.auditService as unknown as {
      events: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
    }).events;
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "website_embed.launch_denied",
        metadata: expect.objectContaining({ origin }),
      }),
    );
  });

  it("rejects embed launches that omit the browser origin header", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-origin-header@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const response = await request(app)
      .post(`/api/v1/public/chat/${token}/sessions`)
      .send({ channel: "website_embed" });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid public chat session request",
    });
  });

  it("creates an anonymous link session", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-session@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1);
    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      publicChatToken: anonymousChatToken,
      publicSessionId: expect.any(String),
      publicSessionToken: expect.any(String),
    });
  });

  it("returns a proxy-aware assistant logo URL for anonymous link sessions", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-chat-logo@example.com");

    await request(app)
      .post("/api/v1/settings/general/assistant-logo")
      .set(adminSessionHeaders(session))
      .attach("logo", Buffer.from("fake-logo"), {
        filename: "assistant.png",
        contentType: "image/png",
      })
      .expect(200);

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      })
      .expect(200);

    const agent = await dependencies.agentService.resolve(session.workspaceId);
    const anonymousChatToken = agent.surfaceSettings.anonymousChat.token;
    expect(anonymousChatToken).toEqual(expect.any(String));

    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .set("X-Forwarded-Prefix", "/backend")
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(200);
    expect(response.body.assistantAvatarUrl).toBe(
      `/backend/api/v1/public/chat/${anonymousChatToken}/assistant-logo`,
    );

    const logo = await request(app)
      .get(`/api/v1/public/chat/${anonymousChatToken}/assistant-logo`);

    expect(logo.status).toBe(200);
    expect(logo.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(logo.body).toString("utf8")).toBe("fake-logo");
  });

  it("returns the current agent token when a legacy workspace public token resolves the launch", async () => {
    const { app, dependencies, repositories } = createTestApp();
    const session = await issueTestSession(app, "public-chat-legacy-token@example.com");
    const legacyToken = "legacy-duplicate-token";
    const currentToken = "current-agent-token";

    await dependencies.workspaceRepository.updateAnonymousChatSettings(session.workspaceId, true, legacyToken, 10);
    const agents = await dependencies.agentService.list(session.workspaceId);
    const sideAgent = await repositories.agentRepository.create(session.workspaceId, {
      name: "Side public agent",
      surfaceSettings: {
        anonymousChat: {
          enabled: true,
          token: "side-agent-token",
        },
      },
    });
    await repositories.agentRepository.update(agents[0].id, session.workspaceId, {
      surfaceSettings: {
        anonymousChat: {
          enabled: true,
          token: currentToken,
        },
      },
    });

    const response = await request(app)
      .post(`/api/v1/public/chat/${legacyToken}/sessions`)
      .send({ channel: "anonymous_link", agentId: sideAgent.id });

    expect(response.status).toBe(200);
    expect(response.body.agentId).toBe(agents[0].id);
    expect(response.body.publicChatToken).toBe(currentToken);

    const chatResponse = await request(app)
      .post(`/api/v1/public/chat/${response.body.publicChatToken}`)
      .set("x-radioso-public-session", response.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(chatResponse.status).toBe(200);
  });

  it("falls back to the current default agent when a signed session carries a stale agent id", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-stale-agent@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1) as string;
    const publicSession = issuePublicChatSession("00112233445566778899aabbccddeeff", {
      workspaceId: session.workspaceId,
      agentId: randomUUID(),
      publicChatToken: anonymousChatToken,
      publicSessionId: randomUUID(),
      sourceChannel: "anonymous",
      sourceOrigin: null,
    });

    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}`)
      .set("x-radioso-public-session", publicSession.token)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(response.status).toBe(200);
    expect(response.body.agentId).toEqual(expect.any(String));
    expect(response.body.agentId).not.toBe(publicSession.agentId);
  });

  it("allows website embed launches even when anonymous chat is disabled", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-independent@example.com");

    const response = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://example.com"],
      });

    const token = response.body.websiteEmbedToken as string;
    const origin = "https://example.com";

    const publicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.body.anonymousChatEnabled).toBe(false);
    expect(publicSession.status).toBe(200);

    const chatResponse = await request(app)
      .post(`/api/v1/public/chat/${publicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(chatResponse.status).toBe(200);
  });

  it("reuses a requested anonymous session id on a later approved bootstrap", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-resume@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const firstPublicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    const firstChat = await request(app)
      .post(`/api/v1/public/chat/${firstPublicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", firstPublicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(firstChat.status).toBe(200);

    const resumedPublicSession = await createWebsiteEmbedPublicSession(app, token, origin, {
      anonymousSessionId: firstChat.headers["x-radioso-anonymous-session"],
    });

    expect(resumedPublicSession.status).toBe(200);

    const historyResponse = await request(app)
      .get(`/api/v1/public/chat/${resumedPublicSession.body.publicChatToken}`)
      .set("x-radioso-public-session", resumedPublicSession.body.publicSessionToken);

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstChat.body.conversationId,
        }),
      ]),
    );
  });

  it("scopes public history to the resolved agent for shared anonymous session ids", async () => {
    const { app } = createTestApp();
    const session = await issueTestToken(app, "public-chat-agent-history-scope@example.com");
    const authorization = `Bearer ${session.token}`;

    const agents = await request(app)
      .get("/api/v1/agents")
      .set("Authorization", authorization)
      .expect(200);
    const defaultAgentId = agents.body.agents[0].id as string;

    await request(app)
      .put(`/api/v1/agents/${defaultAgentId}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
        },
      })
      .expect(200);
    const defaultAgent = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);
    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Side public agent" })
      .expect(201);
    await request(app)
      .put(`/api/v1/agents/${sideAgent.body.id}`)
      .set("Authorization", authorization)
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
        },
      })
      .expect(200);
    const sideAgentWithToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/anonymous-chat-token/rotate`)
      .set("Authorization", authorization)
      .expect(200);

    const defaultToken = defaultAgent.body.surfaceSettings.anonymousChat.token as string;
    const sideToken = sideAgentWithToken.body.surfaceSettings.anonymousChat.token as string;

    const defaultSession = await request(app)
      .post(`/api/v1/public/chat/${defaultToken}/sessions`)
      .send({ channel: "anonymous_link" })
      .expect(200);
    const defaultChat = await request(app)
      .post(`/api/v1/public/chat/${defaultToken}`)
      .set("x-radioso-public-session", defaultSession.body.publicSessionToken)
      .send({ message: "hello default", stream: false })
      .expect(200);

    const sideSession = await request(app)
      .post(`/api/v1/public/chat/${sideToken}/sessions`)
      .send({
        channel: "anonymous_link",
        anonymousSessionId: defaultChat.headers["x-radioso-anonymous-session"],
      })
      .expect(200);

    const sideHistory = await request(app)
      .get(`/api/v1/public/chat/${sideToken}`)
      .set("x-radioso-public-session", sideSession.body.publicSessionToken)
      .expect(200);
    expect(sideHistory.body.conversations).toEqual([]);

    await request(app)
      .get(`/api/v1/public/chat/${sideToken}/history/${defaultChat.body.conversationId}`)
      .set("x-radioso-public-session", sideSession.body.publicSessionToken)
      .expect(404);
  });

  it("records an audit event when launch is denied because embed is disabled", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-embed-disabled-audit@example.com");

    const token = await enableWebsiteEmbed(app, session);
    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: false,
      });

    const origin = "https://example.com";
    const response = await createWebsiteEmbedPublicSession(app, token, origin);

    expect(response.status).toBe(404);

    const auditEvents = (dependencies.auditService as unknown as {
      events: Array<{ eventType: string; metadata?: Record<string, unknown> }>;
    }).events;
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        eventType: "website_embed.launch_denied",
        metadata: expect.objectContaining({
          origin,
          reason: "embed_disabled",
        }),
      }),
    );
  });
});
