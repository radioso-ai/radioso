import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import type { AccessGrant } from "../../src/modules/accessGrants/domain.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";

const grant = (overrides: Partial<AccessGrant> = {}): AccessGrant => ({
  id: "44444444-4444-4444-8444-444444444444",
  agentId,
  workspaceId,
  label: "REST client",
  principalKind: "agent-api",
  role: "agent",
  channel: "agent-api",
  tokenPrefix: "rdso_api",
  tokenHash: "hash",
  encryptedToken: null,
  originConstraint: { mode: "allow-all", origins: [] },
  enabled: true,
  expiresAt: new Date(Date.now() + 60_000),
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
  ...overrides,
});

const answer = {
  conversationId: "55555555-5555-4555-8555-555555555555",
  agentId,
  agentName: "Support",
  answer: "Hello",
  route: { type: "direct", reason: "social_only" },
  citations: [],
  activitySummary: { stages: [] },
  activityTrace: { events: [] },
};

const createDependencies = (overrides: Partial<AppDependencies> = {}): AppDependencies => ({
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
    AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 12,
    AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 3,
    AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 9,
    RADIOSO_TRUSTED_PROXY_HOPS: 0,
  },
  accessGrantService: {
    resolveAgentChannelGrant: vi.fn().mockResolvedValue(grant()),
    evaluate: vi.fn().mockReturnValue({ allowed: true }),
    recordAuthFailure: vi.fn().mockResolvedValue(undefined),
    recordAgentChannelChatSucceeded: vi.fn().mockResolvedValue(undefined),
  },
  abuseControlService: { enforce: vi.fn().mockResolvedValue(undefined), enforceBatch: vi.fn().mockResolvedValue(undefined) },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
  agentRepository: {
    findByIdAndWorkspaceId: vi.fn().mockResolvedValue({ id: agentId, workspaceId }),
  },
  assistantChatService: {
    answer: vi.fn().mockResolvedValue(answer),
    streamAnswer: vi.fn(),
  },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    res.status(statusCode).json({ code: (error as { code?: string }).code ?? "internal_error" });
  });
  return app;
};

describe("REST agent channel chat", () => {
  it("runs chat with the immutable credential and path agent binding", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello", stream: false })
      .expect(200);

    expect(response.body).toMatchObject({ conversationId: answer.conversationId, agentId, answer: "Hello" });
    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "agent.channel.chat.source",
      subjectKey: expect.stringMatching(/^source:[A-Za-z0-9_-]+$/),
    }));
    expect(dependencies.accessGrantService.resolveAgentChannelGrant).toHaveBeenCalledWith("rest-agent-secret", "agent-api");
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).toHaveBeenCalledWith({
      grant: expect.objectContaining({ id: grant().id, agentId, workspaceId, channel: "agent-api" }),
    });
    expect(dependencies.abuseControlService.enforceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ scope: "agent.channel.chat.grant", subjectKey: `grant:${grant().id}` }),
      expect.objectContaining({ scope: "agent.channel.chat.workspace", subjectKey: `workspace:${workspaceId}:global` }),
    ]);
    expect(dependencies.assistantChatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      agentId,
      accountId: undefined,
      message: "Hello",
      sourceChannel: "agent_api",
      sourceOrigin: null,
    }));
  });

  it("derives its source budget from the transport peer, not unsigned forwarding headers", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("X-Forwarded-For", "203.0.113.10")
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(200);
    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("X-Forwarded-For", "198.51.100.20")
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(200);

    const sourceKeys = (dependencies.abuseControlService.enforce as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => (input as { subjectKey: string }).subjectKey);
    expect(new Set(sourceKeys).size).toBe(1);
    expect(sourceKeys.join(" ")).not.toContain("203.0.113.10");
    expect(sourceKeys.join(" ")).not.toContain("198.51.100.20");
  });

  it("uses only the configured trusted XFF suffix behind the hosted proxy", async () => {
    const dependencies = createDependencies({
      env: {
        ...createDependencies().env,
        RADIOSO_TRUSTED_PROXY_HOPS: 2,
      },
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("X-Forwarded-For", "198.51.100.99, 203.0.113.10, 35.191.0.1")
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(200);
    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("X-Forwarded-For", "192.0.2.44, 203.0.113.11, 35.191.0.1")
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(200);

    const sourceKeys = (dependencies.abuseControlService.enforce as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => (input as { subjectKey: string }).subjectKey);
    expect(new Set(sourceKeys).size).toBe(2);
    expect(sourceKeys.join(" ")).not.toContain("198.51.100.99");
    expect(sourceKeys.join(" ")).not.toContain("203.0.113.10");
  });

  it("rejects cross-agent use without entering chat", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${otherAgentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(401);

    expect(dependencies.assistantChatService.answer).not.toHaveBeenCalled();
  });

  it("rejects credentials outside the REST audience", async () => {
    const dependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        resolveAgentChannelGrant: vi.fn().mockResolvedValue(null),
      } as unknown as AppDependencies["accessGrantService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer mcp-or-workspace-secret")
      .send({ message: "Hello" })
      .expect(401);
  });

  it("does not accept a caller-supplied replacement agent id", async () => {
    await request(createApp())
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello", agentId: otherAgentId })
      .expect(400);
  });

  it("validates REST chat before spending a channel budget", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: 42 })
      .expect(400);

    expect(dependencies.abuseControlService.enforceBatch).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.resolveAgentChannelGrant).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.recordAuthFailure).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).not.toHaveBeenCalled();
    expect(dependencies.assistantChatService.answer).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).not.toHaveBeenCalled();
  });

  it("rejects oversized bearer credentials before lookup or audit", async () => {
    const dependencies = createDependencies();

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", `Bearer ${"x".repeat(2049)}`)
      .send({ message: "Hello" })
      .expect(401);

    expect(dependencies.accessGrantService.resolveAgentChannelGrant).not.toHaveBeenCalled();
    expect(dependencies.accessGrantService.recordAuthFailure).not.toHaveBeenCalled();
  });

  it("does not record successful use when provider work fails", async () => {
    const dependencies = createDependencies({
      assistantChatService: {
        answer: vi.fn().mockRejectedValue(new Error("provider failed")),
        streamAnswer: vi.fn(),
      } as unknown as AppDependencies["assistantChatService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(500);

    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).not.toHaveBeenCalled();
  });

  it("does not record successful use when an SSE stream fails before completion", async () => {
    async function* failedStream() {
      throw new Error("provider unavailable");
      yield { type: "chunk" as const, text: "unreachable" };
    }
    const dependencies = createDependencies({
      assistantChatService: {
        answer: vi.fn(),
        streamAnswer: vi.fn().mockReturnValue(failedStream()),
      } as unknown as AppDependencies["assistantChatService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello", stream: true })
      .expect(500);

    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).not.toHaveBeenCalled();
  });

  it("stops REST chat before provider work when the grant budget is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: {
        enforce: vi.fn().mockResolvedValue(undefined),
        enforceBatch: vi.fn().mockRejectedValue({ statusCode: 429, code: "rate_limit_exceeded" }),
      } as unknown as AppDependencies["abuseControlService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(429);

    expect(dependencies.assistantChatService.answer).not.toHaveBeenCalled();
  });

  it("keeps completed JSON, no-content, and SSE responses successful when the best-effort audit fails", async () => {
    const failedAudit = { record: vi.fn().mockRejectedValue(new Error("audit unavailable")) };
    const bestEffortAudit = vi.fn(() => {
      void failedAudit.record({ eventType: "agent_api.chat" }).catch(() => undefined);
    });

    const jsonDependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        recordAgentChannelChatSucceeded: bestEffortAudit,
      } as unknown as AppDependencies["accessGrantService"],
    });
    await request(createApp(jsonDependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(200);

    const noContentDependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        recordAgentChannelChatSucceeded: bestEffortAudit,
      } as unknown as AppDependencies["accessGrantService"],
      assistantChatService: {
        answer: vi.fn().mockResolvedValue(null),
        streamAnswer: vi.fn(),
      } as unknown as AppDependencies["assistantChatService"],
    });
    await request(createApp(noContentDependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(204);

    async function* stream() {
      yield { type: "chunk" as const, text: "Hello" };
    }
    const sseDependencies = createDependencies({
      accessGrantService: {
        ...createDependencies().accessGrantService,
        recordAgentChannelChatSucceeded: bestEffortAudit,
      } as unknown as AppDependencies["accessGrantService"],
      assistantChatService: {
        answer: vi.fn(),
        streamAnswer: vi.fn().mockReturnValue(stream()),
      } as unknown as AppDependencies["assistantChatService"],
    });
    await request(createApp(sseDependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello", stream: true })
      .expect(200);

    await Promise.resolve();
    expect(bestEffortAudit).toHaveBeenCalledTimes(3);
  });
});
