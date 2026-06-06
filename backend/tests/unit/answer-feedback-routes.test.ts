import express from "express";
import type { QueryResultRow } from "pg";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAnswerFeedbackRoutes, type AnswerFeedbackRouteDependencies } from "../../src/modules/chat/routes/answerFeedbackRoutes.js";
import { AnswerFeedbackService } from "../../src/modules/chat/services/answerFeedbackService.js";
import type { ApplicationDatabasePort } from "../../src/app/composition/applicationModule.js";
import { issuePublicChatSession } from "../../src/modules/settings/contracts/publicChatSession.js";

type FeedbackRow = QueryResultRow & {
  id: string;
  assistant_message_id: string;
  actor_type: string;
  actor_id: string;
  value: string;
  comment: string | null;
};

class FakeAnswerFeedbackRouteDatabase implements ApplicationDatabasePort {
  readonly assistantMessages = new Map<string, {
    workspaceId: string;
    conversationId: string;
    anonymousSessionId: string | null;
    agentId: string | null;
    role: "assistant" | "user";
  }>();
  readonly feedback = new Map<string, FeedbackRow>();

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("SELECT m.conversation_id")) {
      const workspaceId = String(params[0]);
      const messageId = String(params[1]);
      let nextParamIndex = 2;
      const anonymousSessionId = text.includes("c.anonymous_session_id")
        ? String(params[nextParamIndex++])
        : undefined;
      const agentId = text.includes("c.agent_id")
        ? String(params[nextParamIndex++])
        : undefined;
      const message = this.assistantMessages.get(messageId);
      if (
        !message ||
        message.workspaceId !== workspaceId ||
        message.role !== "assistant" ||
        (anonymousSessionId !== undefined && message.anonymousSessionId !== anonymousSessionId) ||
        (agentId !== undefined && message.agentId !== agentId)
      ) {
        return [] as T[];
      }
      return [{ conversation_id: message.conversationId }] as unknown as T[];
    }

    if (text.includes("INSERT INTO assistant_answer_feedback")) {
      const row = {
        id: String(params[0]),
        workspace_id: String(params[1]),
        conversation_id: String(params[2]),
        assistant_message_id: String(params[3]),
        account_id: params[4] === null ? null : String(params[4]),
        user_id: params[5] === null ? null : String(params[5]),
        anonymous_session_id: params[6] === null ? null : String(params[6]),
        actor_type: String(params[7]),
        actor_id: String(params[8]),
        value: String(params[9]),
        comment: params[10] === null ? null : String(params[10]),
        created_at: new Date("2026-05-07T11:00:00.000Z"),
        updated_at: new Date("2026-05-07T11:00:00.000Z"),
      };
      this.feedback.set(`${row.assistant_message_id}:${row.actor_type}:${row.actor_id}`, row);
      return [row] as unknown as T[];
    }

    if (text.includes("DELETE FROM assistant_answer_feedback")) {
      const key = `${String(params[1])}:${String(params[2])}:${String(params[3])}`;
      const row = this.feedback.get(key);
      this.feedback.delete(key);
      return (row ? [{ id: "feedback-1" }] : []) as unknown as T[];
    }

    return [] as T[];
  }
}

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-4444-444444444444";
const CONVERSATION_ID = "55555555-5555-5555-5555-555555555555";
const PUBLIC_SESSION_ID = "66666666-6666-6666-6666-666666666666";
const AGENT_ID = "77777777-7777-7777-7777-777777777777";
const PUBLIC_TOKEN = "public-token";
const PUBLIC_SECRET = "public-secret";

const issueSession = (
  publicChatToken = PUBLIC_TOKEN,
  sourceChannel: "anonymous" | "website_embed" = "anonymous",
  sourceOrigin: string | null = null,
) => issuePublicChatSession(PUBLIC_SECRET, {
  workspaceId: WORKSPACE_ID,
  agentId: AGENT_ID,
  publicChatToken,
  publicSessionId: PUBLIC_SESSION_ID,
  sourceChannel,
  sourceOrigin,
}).token;

const createDependencies = (
  overrides: Partial<AnswerFeedbackRouteDependencies> = {},
): AnswerFeedbackRouteDependencies => ({
  env: {
    NODE_ENV: "test",
    PUBLIC_CHAT_SESSION_SECRET: PUBLIC_SECRET,
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "session-secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
  },
  authService: {
    async authenticateSession(token) {
      if (token !== "valid-session") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" };
    },
    async authenticateApiToken(token) {
      if (token !== "valid-token") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return {
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        principal: { type: "workspace_api_token", role: "admin", tokenId: "token-id" },
      };
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission() {},
  },
  workspaceSessionService: {
    async resolve() {
      return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
    },
  },
  workspaceRepository: {
    async findByAnonymousChatToken(token) {
      return token === PUBLIC_TOKEN
        ? {
            id: WORKSPACE_ID,
            name: "Test workspace",
            assistantName: "Assistant",
            anonymousChatEnabled: true,
            anonymousChatToken: token,
            websiteEmbedEnabled: false,
            websiteEmbedToken: null,
            websiteEmbedAllowedOrigins: [],
            websiteEmbedLauncherLabel: null,
            websiteEmbedLauncherPosition: null,
            proactiveGreetingEnabled: false,
            defaultAgentId: AGENT_ID,
          } as any
        : null;
    },
    async findByWebsiteEmbedToken() {
      return null;
    },
    async findById(id) {
      return id === WORKSPACE_ID
        ? {
            id: WORKSPACE_ID,
            name: "Test workspace",
            assistantName: "Assistant",
            anonymousChatEnabled: true,
            anonymousChatToken: PUBLIC_TOKEN,
            websiteEmbedEnabled: false,
            websiteEmbedToken: null,
            websiteEmbedAllowedOrigins: [],
            websiteEmbedLauncherLabel: null,
            websiteEmbedLauncherPosition: null,
            proactiveGreetingEnabled: false,
            defaultAgentId: AGENT_ID,
          } as any
        : null;
    },
  },
  agentRepository: {
    async findByAnonymousChatToken(token) {
      return token === PUBLIC_TOKEN
        ? {
            id: AGENT_ID,
            workspaceId: WORKSPACE_ID,
            name: "Assistant",
            logo: null,
            theme: {},
            branding: {},
            proactiveGreetingEnabled: false,
            surfaceSettings: {
              authenticatedChat: { enabled: true },
              anonymousChat: { enabled: true, token },
              websiteEmbed: { enabled: false, token: null },
              extensions: {},
            },
          } as any
        : null;
    },
    async findByWebsiteEmbedToken() {
      return null;
    },
    async findByIdAndWorkspaceId() {
      return null;
    },
  },
  ...overrides,
});

const createApp = (
  database: FakeAnswerFeedbackRouteDatabase,
  overrides: Partial<AnswerFeedbackRouteDependencies> = {},
) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim().split("="))
        .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0])),
    );
    next();
  });
  app.use(
    "/api/v1/answer-feedback",
    createAnswerFeedbackRoutes(createDependencies(overrides), new AnswerFeedbackService(database)),
  );
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return app;
};

const seedMessage = (
  database: FakeAnswerFeedbackRouteDatabase,
  anonymousSessionId: string | null = null,
  agentId: string | null = null,
) => {
  database.assistantMessages.set(MESSAGE_ID, {
    workspaceId: WORKSPACE_ID,
    conversationId: CONVERSATION_ID,
    anonymousSessionId,
    agentId,
    role: "assistant",
  });
};

describe("answer feedback routes", () => {
  it("accepts signed-in feedback for an assistant message", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database);

    const response = await request(createApp(database))
      .put(`/api/v1/answer-feedback/messages/${MESSAGE_ID}`)
      .set("Cookie", "radioso_session=valid-session")
      .send({ value: "down", comment: "Not enough detail" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "down",
      comment: "Not enough detail",
      actorType: "authenticated_user",
      userId: USER_ID,
    }));
  });

  it("accepts API token feedback for an assistant message", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database);

    const response = await request(createApp(database))
      .put(`/api/v1/answer-feedback/messages/${MESSAGE_ID}`)
      .set("Authorization", "Bearer valid-token")
      .send({ value: "up" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "up",
      comment: null,
      actorType: "api_token",
      accountId: ACCOUNT_ID,
    }));
  });

  it("accepts public chat session feedback for the same anonymous session", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database, PUBLIC_SESSION_ID, AGENT_ID);
    const app = createApp(database);

    const response = await request(app)
      .put(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issueSession())
      .send({ value: "down" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "down",
      actorType: "anonymous_user",
      anonymousSessionId: PUBLIC_SESSION_ID,
    }));

    await request(app)
      .delete(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issueSession())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ cleared: true });
      });
  });

  it("checks the public feedback permission before writing public feedback", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database, PUBLIC_SESSION_ID, AGENT_ID);
    const requirePermission = vi.fn().mockResolvedValue(undefined);
    const app = createApp(database, {
      accountAccessService: {
        async requireActiveMembership() {},
        requirePermission,
      },
    });

    await request(app)
      .put(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issueSession())
      .send({ value: "down" })
      .expect(200);

    expect(requirePermission).toHaveBeenCalledWith(expect.objectContaining({
      permission: "public_chat.feedback.write.own",
      principal: expect.objectContaining({
        type: "public_chat_session",
        publicSessionId: PUBLIC_SESSION_ID,
      }),
      workspaceId: WORKSPACE_ID,
    }));
  });

  it("accepts public chat session feedback for agent-owned website embed tokens", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    const embedToken = "agent-embed-token";
    seedMessage(database, PUBLIC_SESSION_ID, AGENT_ID);
    const app = createApp(database, {
      agentRepository: {
        async findByAnonymousChatToken() {
          return null;
        },
        async findByWebsiteEmbedToken(token) {
          return token === embedToken
            ? {
                id: AGENT_ID,
                workspaceId: WORKSPACE_ID,
                name: "Assistant",
                logo: null,
                theme: {},
                branding: {},
                proactiveGreetingEnabled: false,
                surfaceSettings: {
                  authenticatedChat: { enabled: true },
                  anonymousChat: { enabled: false, token: null },
              websiteEmbed: { enabled: true, token: embedToken, allowedOrigins: ["https://example.com"] },
                  extensions: {},
                },
              } as any
            : null;
        },
        async findByIdAndWorkspaceId() {
          return null;
        },
      },
    });

    const response = await request(app)
      .put(`/api/v1/answer-feedback/public/chat/${embedToken}/messages/${MESSAGE_ID}`)
      .set("Origin", "https://example.com")
      .set("X-Radioso-Public-Session", issueSession(embedToken, "website_embed", "https://example.com"))
      .send({ value: "down" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "down",
      actorType: "anonymous_user",
      anonymousSessionId: PUBLIC_SESSION_ID,
    }));
  });

  it("rejects invalid public sessions and cross-session messages", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database, "other-session", AGENT_ID);

    await request(createApp(database))
      .put(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .send({ value: "up" })
      .expect(404);

    await request(createApp(database))
      .put(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issueSession())
      .send({ value: "up" })
      .expect(404);

    await request(createApp(database))
      .delete(`/api/v1/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issueSession())
      .expect(404);
  });
});
