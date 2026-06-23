import { randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAnswerFeedbackRoutes, type AnswerFeedbackRouteDependencies } from "../../src/modules/chat/routes/answerFeedbackRoutes.js";
import type { AnswerFeedbackService } from "../../src/modules/chat/services/answerFeedbackService.js";
import type { ChatAnswerFeedbackEntry } from "../../src/modules/chat/services/answerFeedbackHistoryProvider.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { issuePublicChatSession } from "../../src/modules/settings/contracts/publicChatSession.js";

interface FeedbackRow extends ChatAnswerFeedbackEntry {
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string;
}

// In-memory stand-in for the Kysely-backed AnswerFeedbackService. These route tests
// characterize auth/session wiring, not SQL, so the fake reproduces the service's
// message-scope rule (assistant role, workspace, optional anonymous session / agent)
// and one-active-entry-per-actor upsert/clear semantics without a database.
class InMemoryAnswerFeedbackService {
  readonly assistantMessages = new Map<string, {
    workspaceId: string;
    conversationId: string;
    anonymousSessionId: string | null;
    agentId: string | null;
    role: "assistant" | "user";
  }>();
  readonly feedback = new Map<string, FeedbackRow>();

  private resolveConversationId(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    anonymousSessionId?: string | null;
  }): string {
    const message = this.assistantMessages.get(input.assistantMessageId);
    if (
      !message ||
      message.workspaceId !== input.workspaceId ||
      message.role !== "assistant" ||
      (input.anonymousSessionId != null && message.anonymousSessionId !== input.anonymousSessionId) ||
      (input.agentId != null && message.agentId !== input.agentId)
    ) {
      throw notFound("Assistant message not found");
    }
    return message.conversationId;
  }

  async upsert(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    value: "up" | "down";
    comment?: string | null;
    actor: {
      type: "authenticated_user" | "api_token" | "anonymous_user";
      id: string;
      accountId?: string | null;
      userId?: string | null;
      anonymousSessionId?: string | null;
    };
  }): Promise<ChatAnswerFeedbackEntry> {
    const conversationId = this.resolveConversationId({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      assistantMessageId: input.assistantMessageId,
      anonymousSessionId: input.actor.type === "anonymous_user" ? input.actor.anonymousSessionId : null,
    });
    const comment = input.value === "down" ? (input.comment?.trim() || null) : null;
    const key = `${input.assistantMessageId}:${input.actor.type}:${input.actor.id}`;
    const existing = this.feedback.get(key);
    const row: FeedbackRow = {
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      conversationId,
      assistantMessageId: input.assistantMessageId,
      value: input.value,
      comment,
      actorType: input.actor.type,
      actorId: input.actor.id,
      accountId: input.actor.accountId ?? null,
      userId: input.actor.userId ?? null,
      anonymousSessionId: input.actor.anonymousSessionId ?? null,
      createdAt: existing?.createdAt ?? new Date("2026-05-07T11:00:00.000Z").toISOString(),
      updatedAt: new Date("2026-05-07T11:00:00.000Z").toISOString(),
    };
    this.feedback.set(key, row);
    const { workspaceId: _w, conversationId: _c, assistantMessageId: _m, ...entry } = row;
    return entry;
  }

  async clear(input: {
    workspaceId: string;
    agentId?: string | null;
    assistantMessageId: string;
    actor: {
      type: "authenticated_user" | "api_token" | "anonymous_user";
      id: string;
      anonymousSessionId?: string | null;
    };
  }): Promise<{ cleared: boolean }> {
    this.resolveConversationId({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      assistantMessageId: input.assistantMessageId,
      anonymousSessionId: input.actor.type === "anonymous_user" ? input.actor.anonymousSessionId : null,
    });
    const key = `${input.assistantMessageId}:${input.actor.type}:${input.actor.id}`;
    const had = this.feedback.delete(key);
    return { cleared: had };
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
  database: InMemoryAnswerFeedbackService,
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
    createAnswerFeedbackRoutes(createDependencies(overrides), database as unknown as AnswerFeedbackService),
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
  database: InMemoryAnswerFeedbackService,
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
    const database = new InMemoryAnswerFeedbackService();
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
    const database = new InMemoryAnswerFeedbackService();
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
    const database = new InMemoryAnswerFeedbackService();
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
    const database = new InMemoryAnswerFeedbackService();
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
    const database = new InMemoryAnswerFeedbackService();
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
    const database = new InMemoryAnswerFeedbackService();
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
