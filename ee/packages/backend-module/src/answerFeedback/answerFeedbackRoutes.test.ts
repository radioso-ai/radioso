import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ApplicationRouteMount, UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { createAnswerFeedbackRoutes } from "./answerFeedbackRoutes.js";
import { EnterpriseAnswerFeedbackService } from "./answerFeedbackService.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

class FakeAnswerFeedbackRouteDatabase implements UsageLimitDatabasePort {
  readonly assistantMessages = new Map<string, {
    workspaceId: string;
    conversationId: string;
    anonymousSessionId: string | null;
    agentId: string | null;
    role: "assistant" | "user";
  }>();
  readonly feedback = new Map<string, unknown>();

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
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
      return [{ conversation_id: message.conversationId }] as T[];
    }

    if (text.includes("INSERT INTO ee_assistant_answer_feedback")) {
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
      return [row] as T[];
    }

    if (text.includes("DELETE FROM ee_assistant_answer_feedback")) {
      const key = `${String(params[1])}:${String(params[2])}:${String(params[3])}`;
      const row = this.feedback.get(key);
      this.feedback.delete(key);
      return (row ? [{ id: "feedback-1" }] : []) as T[];
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

const issuePublicSession = (
  publicChatToken = PUBLIC_TOKEN,
  sourceChannel: "anonymous" | "website_embed" = "anonymous",
) => {
  const payload = Buffer.from(JSON.stringify({
    workspaceId: WORKSPACE_ID,
    publicChatToken,
    publicSessionId: PUBLIC_SESSION_ID,
    sourceChannel,
    expiresAt: "2099-01-01T00:00:00.000Z",
  })).toString("base64url");
  const signature = createHmac("sha256", PUBLIC_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
};

const createDependencies = (
  database: FakeAnswerFeedbackRouteDatabase,
  overrides: Partial<RouteDependencies> = {},
): RouteDependencies => ({
  connectorDb: database,
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
    PUBLIC_CHAT_SESSION_SECRET: PUBLIC_SECRET,
  },
  abuseControlService: {
    async enforce() {},
  },
  auditService: {
    async record() {},
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
      return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
  },
  workspaceSessionService: {
    async resolve() {
      return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
    },
  },
  userRepository: {
    async findById() {
      return null;
    },
  },
  workspaceRepository: {
    async findByAnonymousChatToken(token) {
      return token === PUBLIC_TOKEN ? { id: WORKSPACE_ID } : null;
    },
  },
  ...overrides,
});

const createApp = (database: FakeAnswerFeedbackRouteDatabase, overrides: Partial<RouteDependencies> = {}) => {
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
    "/api/v1/ee/answer-feedback",
    createAnswerFeedbackRoutes(createDependencies(database, overrides), new EnterpriseAnswerFeedbackService(database)),
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

describe("enterprise answer feedback routes", () => {
  it("accepts signed-in feedback for an assistant message", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database);

    const response = await request(createApp(database))
      .put(`/api/v1/ee/answer-feedback/messages/${MESSAGE_ID}`)
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
      .put(`/api/v1/ee/answer-feedback/messages/${MESSAGE_ID}`)
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
    seedMessage(database, PUBLIC_SESSION_ID);
    const app = createApp(database);

    const response = await request(app)
      .put(`/api/v1/ee/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession())
      .send({ value: "down" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "down",
      actorType: "anonymous_user",
      anonymousSessionId: PUBLIC_SESSION_ID,
    }));

    await request(app)
      .delete(`/api/v1/ee/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession())
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({ cleared: true });
      });
  });

  it("accepts public chat session feedback for agent-owned website embed tokens", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database, PUBLIC_SESSION_ID, AGENT_ID);
    const embedToken = "agent-embed-token";
    const agentOverrides: Partial<RouteDependencies> = {
      agentRepository: {
        async findByAnonymousChatToken() {
          return null;
        },
        async findByWebsiteEmbedToken(token) {
          return token === embedToken
            ? {
                id: AGENT_ID,
                workspaceId: WORKSPACE_ID,
                surfaceSettings: {
                  anonymousChat: { enabled: false, token: null },
                  websiteEmbed: { enabled: true, token: embedToken },
                },
              }
            : null;
        },
      },
    };
    const app = createApp(database, agentOverrides);

    const response = await request(app)
      .put(`/api/v1/ee/answer-feedback/public/chat/${embedToken}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession(embedToken, "website_embed"))
      .send({ value: "down" })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      value: "down",
      actorType: "anonymous_user",
      anonymousSessionId: PUBLIC_SESSION_ID,
    }));

    const crossAgentDatabase = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(crossAgentDatabase, PUBLIC_SESSION_ID, "88888888-8888-8888-8888-888888888888");
    await request(createApp(crossAgentDatabase, agentOverrides))
      .put(`/api/v1/ee/answer-feedback/public/chat/${embedToken}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession(embedToken, "website_embed"))
      .send({ value: "down" })
      .expect(404);
  });

  it("rejects invalid public sessions and cross-session messages", async () => {
    const database = new FakeAnswerFeedbackRouteDatabase();
    seedMessage(database, "other-session");

    await request(createApp(database))
      .put(`/api/v1/ee/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .send({ value: "up" })
      .expect(404);

    await request(createApp(database))
      .put(`/api/v1/ee/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession())
      .send({ value: "up" })
      .expect(404);

    await request(createApp(database))
      .delete(`/api/v1/ee/answer-feedback/public/chat/${PUBLIC_TOKEN}/messages/${MESSAGE_ID}`)
      .set("X-Radioso-Public-Session", issuePublicSession())
      .expect(404);
  });
});
