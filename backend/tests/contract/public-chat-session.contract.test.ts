import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";

import {
  issueConverseChatSession,
  issuePublicChatSession,
  verifyConverseChatSession,
} from "../../src/modules/settings/contracts/publicChatSession.js";
import type { PublicChatActionAdvertiserPort } from "../../src/modules/chat/services/publicChatActionAdvertiser.js";
import { adminSessionHeaders, createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

describe("public chat session contract", () => {
  const decodePublicSessionPayload = (token: string): Record<string, unknown> => {
    const [encodedPayload] = token.split(".");
    if (!encodedPayload) {
      throw new Error("Missing public session payload");
    }
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
  };

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

  it("issues and verifies MCP converse sessions with grant identity and version fields", () => {
    const secret = "00112233445566778899aabbccddeeff";
    const session = issueConverseChatSession(secret, {
      workspaceId: randomUUID(),
      agentId: randomUUID(),
      publicSessionId: randomUUID(),
      grantId: randomUUID(),
      grantVersion: "2026-06-27T09:30:00.000Z",
    });

    const decoded = decodePublicSessionPayload(session.token);
    expect(decoded).toMatchObject({
      sourceChannel: "mcp",
      sourceOrigin: null,
      grantId: session.grantId,
      grantVersion: "2026-06-27T09:30:00.000Z",
    });

    expect(verifyConverseChatSession(session.token, secret)).toMatchObject({
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      publicSessionId: session.publicSessionId,
      sourceChannel: "mcp",
      sourceOrigin: null,
      grantId: session.grantId,
      grantVersion: "2026-06-27T09:30:00.000Z",
    });
  });

  it("does not verify public-chat sessions as MCP converse sessions", () => {
    const secret = "00112233445566778899aabbccddeeff";
    const session = issuePublicChatSession(secret, {
      workspaceId: randomUUID(),
      agentId: randomUUID(),
      publicChatToken: "launch-token",
      publicSessionId: randomUUID(),
      sourceChannel: "anonymous",
      sourceOrigin: null,
    });

    expect(verifyConverseChatSession(session.token, secret)).toBeNull();
  });

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
      resumeToken: expect.any(String),
      assistantBootstrapActive: false,
    });
    expect(response.body.expiresAt).toEqual(expect.any(String));
    expect(response.body.resumeExpiresAt).toEqual(expect.any(String));
  });

  it("streams website embed chat from the bound approved origin", async () => {
    const { app } = createTestApp({
      chatGateway: {
        async answer() {
          return "unused";
        },
        async *streamAnswer() {
          yield "Public ";
          yield "streaming works.";
        },
      },
    });
    const session = await issueTestSession(app, "public-embed-streaming@example.com");
    const token = await enableWebsiteEmbed(app, session);
    const publicSession = await createWebsiteEmbedPublicSession(app, token, "https://example.com");

    const response = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("Origin", "https://example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .buffer(true)
      .parse((res, callback) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => callback(null, body));
      })
      .send({ message: "Hello", stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: done");
  });

  it("keeps approved website embed assistant errors browser-readable", async () => {
    const { app, dependencies } = createTestApp();
    dependencies.assistantChatService.answer = async () => null;
    const session = await issueTestSession(app, "public-embed-empty-error-cors@example.com");
    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";
    const publicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    const response = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "Hello", stream: false });

    expect(response.status).toBe(503);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers.vary).toContain("Origin");
    expect(response.body.error).toMatchObject({
      code: "service_unavailable",
      details: {
        code: "public_chat_empty_response",
      },
    });

    const denied = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("Origin", "https://not-approved.example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "Hello", stream: false });

    expect(denied.status).toBe(404);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not authorize denied-origin public chat preflight requests", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-preflight-denied@example.com");
    const token = await enableWebsiteEmbed(app, session);

    const response = await request(app)
      .options(`/api/v1/public/chat/${token}`)
      .set("Origin", "https://not-approved.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,x-radioso-public-session");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes configured public intake actions on website embed sessions and conversation lists", async () => {
    const publicChatActionAdvertiser: PublicChatActionAdvertiserPort = {
      async getPublicIntakeActions(input) {
        expect(input.sourceChannel).toBe("website_embed");
        return [{
          skillName: "human_contact.request",
          intentName: "explicit_contact_request",
        }];
      },
    };
    const { app } = createTestApp({ publicChatActionAdvertiser });
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
      .set("Origin", "https://example.com")
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
      .set("Origin", origin)
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

  it("rejects website embed messages from an origin that does not match the public session", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-message-origin-mismatch@example.com");
    const token = await enableWebsiteEmbed(app, session);
    const publicSession = await createWebsiteEmbedPublicSession(app, token, "https://example.com");

    const response = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("Origin", "https://other.example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "Hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("rejects website embed messages after the bound origin is removed from the allowlist", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-removed-origin@example.com");
    const token = await enableWebsiteEmbed(app, session);
    const publicSession = await createWebsiteEmbedPublicSession(app, token, "https://example.com");

    await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        websiteEmbedEnabled: true,
        websiteEmbedAllowedOrigins: ["https://other.example.com"],
      })
      .expect(200);

    const response = await request(app)
      .post(`/api/v1/public/chat/${token}`)
      .set("Origin", "https://example.com")
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({ message: "Hello", stream: false });

    expect(response.status).toBe(404);
  });

  it("rejects public session credentials on workspace and MCP bearer endpoints", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-bearer-rejected@example.com");
    const token = await enableWebsiteEmbed(app, session);
    const publicSession = await createWebsiteEmbedPublicSession(app, token, "https://example.com");
    const authorization = `Bearer ${publicSession.body.publicSessionToken}`;

    await request(app)
      .get("/api/v1/workspace/summary")
      .set("Authorization", authorization)
      .expect(401);

    await request(app)
      .get("/api/v1/workspace/mcp/context")
      .set("Authorization", authorization)
      .expect(404);
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

  it("does not embed the raw launch token in the signed public session payload", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-chat-session-token-binding@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1) as string;
    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(200);
    const decodedPayload = decodePublicSessionPayload(response.body.publicSessionToken);
    expect(decodedPayload.publicChatToken).toBeUndefined();
    expect(decodedPayload.launchTokenBinding).toEqual(expect.any(String));
    expect(JSON.stringify(decodedPayload)).not.toContain(anonymousChatToken);
  });

  it("rate limits repeated public session exchanges before session issuance", async () => {
    const { app } = createTestApp({
      envOverrides: {
        PUBLIC_CHAT_SESSION_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });
    const session = await issueTestSession(app, "public-chat-session-rate-limit@example.com");

    const settings = await request(app)
      .put("/api/v1/settings/general")
      .set(adminSessionHeaders(session))
      .send({
        anonymousChatEnabled: true,
      });

    const anonymousChatToken = new URL(settings.body.anonymousChatUrl).pathname.split("/").at(-1);
    await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" })
      .expect(200);

    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(429);
    expect(response.body.error).toMatchObject({
      code: "rate_limit_exceeded",
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
    if (!agent.logo) {
      throw new Error("Expected uploaded logo");
    }

    const response = await request(app)
      .post(`/api/v1/public/chat/${anonymousChatToken}/sessions`)
      .set("X-Forwarded-Prefix", "/backend")
      .send({ channel: "anonymous_link" });

    expect(response.status).toBe(200);
    const assistantAvatarUrl = new URL(response.body.assistantAvatarUrl, "https://app.example.com");
    expect(assistantAvatarUrl.pathname).toBe(`/backend/api/v1/public/chat/${anonymousChatToken}/assistant-logo`);
    expect(assistantAvatarUrl.searchParams.get("v")).toMatch(/^[a-z0-9]+:[^:]*:\d+$/);
    expect(assistantAvatarUrl.searchParams.get("v")).not.toContain(agent.logo.objectPath);

    const logo = await request(app)
      .get(`/api/v1/public/chat/${anonymousChatToken}/assistant-logo`);

    expect(logo.status).toBe(200);
    expect(logo.headers["content-type"]).toContain("image/png");
    expect(logo.headers["content-disposition"]).toBe('inline; filename="logo"');
    expect(Buffer.from(logo.body).toString("utf8")).toBe("fake-logo");
  });

  it("falls back to octet-stream when stored assistant logo metadata has an unsafe content type", async () => {
    const { app, dependencies } = createTestApp();
    const session = await issueTestSession(app, "public-chat-logo-unsafe-mime@example.com");

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
    if (!agent.logo) {
      throw new Error("Expected uploaded logo");
    }
    await dependencies.agentRepository.update(agent.id, session.workspaceId, {
      logo: {
        ...agent.logo,
        mimeType: "text/html",
      },
    } as never);

    const response = await request(app)
      .get(`/api/v1/public/chat/${agent.surfaceSettings.anonymousChat.token}/assistant-logo`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/octet-stream");
    expect(response.headers["content-disposition"]).toBe('inline; filename="logo"');
    expect(Buffer.from(response.body).toString("utf8")).toBe("fake-logo");
  });

  it("allows approved website embed origins to load the assistant logo with CORS", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-logo-cors@example.com");

    await request(app)
      .post("/api/v1/settings/general/assistant-logo")
      .set(adminSessionHeaders(session))
      .attach("logo", Buffer.from("embed-logo"), {
        filename: "assistant.png",
        contentType: "image/png",
      })
      .expect(200);

    const token = await enableWebsiteEmbed(app, session);

    const allowedLogo = await request(app)
      .get(`/api/v1/public/chat/${token}/assistant-logo`)
      .set("Origin", "https://example.com");

    expect(allowedLogo.status).toBe(200);
    expect(allowedLogo.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(allowedLogo.headers.vary).toContain("Origin");
    expect(Buffer.from(allowedLogo.body).toString("utf8")).toBe("embed-logo");

    const deniedLogo = await request(app)
      .get(`/api/v1/public/chat/${token}/assistant-logo`)
      .set("Origin", "https://not-approved.example.com");

    expect(deniedLogo.status).toBe(200);
    expect(deniedLogo.headers["access-control-allow-origin"]).toBeUndefined();
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
      .set("Origin", origin)
      .set("x-radioso-public-session", publicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(chatResponse.status).toBe(200);
  });

  it("resumes website embed history with a signed resume token", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-resume@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const firstPublicSession = await createWebsiteEmbedPublicSession(app, token, origin);

    const firstChat = await request(app)
      .post(`/api/v1/public/chat/${firstPublicSession.body.publicChatToken}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", firstPublicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(firstChat.status).toBe(200);

    const resumedPublicSession = await createWebsiteEmbedPublicSession(app, token, origin, {
      resumeToken: firstPublicSession.body.resumeToken,
    });

    expect(resumedPublicSession.status).toBe(200);

    const historyResponse = await request(app)
      .get(`/api/v1/public/chat/${resumedPublicSession.body.publicChatToken}`)
      .set("Origin", origin)
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

  it("does not resume website embed history from a raw anonymous session id", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-raw-session-resume@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const origin = "https://example.com";

    const firstPublicSession = await createWebsiteEmbedPublicSession(app, token, origin);
    const firstChat = await request(app)
      .post(`/api/v1/public/chat/${firstPublicSession.body.publicChatToken}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", firstPublicSession.body.publicSessionToken)
      .send({
        message: "What can you do?",
        stream: false,
      });

    expect(firstChat.status).toBe(200);

    const nextPublicSession = await createWebsiteEmbedPublicSession(app, token, origin, {
      anonymousSessionId: firstChat.headers["x-radioso-anonymous-session"],
    });

    expect(nextPublicSession.status).toBe(200);
    expect(nextPublicSession.body.publicSessionId).not.toBe(firstChat.headers["x-radioso-anonymous-session"]);

    const historyResponse = await request(app)
      .get(`/api/v1/public/chat/${nextPublicSession.body.publicChatToken}`)
      .set("Origin", origin)
      .set("x-radioso-public-session", nextPublicSession.body.publicSessionToken);

    expect(historyResponse.status).toBe(200);
    expect(historyResponse.body.conversations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstChat.body.conversationId,
        }),
      ]),
    );
  });

  it("rejects a malformed public session resume token", async () => {
    const { app } = createTestApp();
    const session = await issueTestSession(app, "public-embed-invalid-resume@example.com");

    const token = await enableWebsiteEmbed(app, session);
    const response = await createWebsiteEmbedPublicSession(app, token, "https://example.com", {
      resumeToken: "not-a-valid-resume-token",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "bad_request",
      message: "Invalid public chat session request",
    });
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
      .set(adminSessionHeaders(session))
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
        },
      })
      .expect(200);
    const defaultAgent = await request(app)
      .post(`/api/v1/agents/${defaultAgentId}/anonymous-chat-token/rotate`)
      .set("Cookie", session.cookie)
      .set("X-Workspace-Id", session.workspaceId)
      .expect(200);
    const sideAgent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({ name: "Side public agent" })
      .expect(201);
    await request(app)
      .put(`/api/v1/agents/${sideAgent.body.id}`)
      .set(adminSessionHeaders(session))
      .send({
        surfaceSettings: {
          anonymousChat: { enabled: true },
        },
      })
      .expect(200);
    const sideAgentWithToken = await request(app)
      .post(`/api/v1/agents/${sideAgent.body.id}/anonymous-chat-token/rotate`)
      .set("Cookie", session.cookie)
      .set("X-Workspace-Id", session.workspaceId)
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
