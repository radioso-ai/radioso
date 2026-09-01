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
  env: { SESSION_COOKIE_NAME: "radioso_session" },
  accessGrantService: {
    resolveAgentChannelGrant: vi.fn().mockResolvedValue(grant()),
    evaluate: vi.fn().mockReturnValue({ allowed: true }),
    touchGrant: vi.fn().mockResolvedValue(undefined),
    recordAuthFailure: vi.fn().mockResolvedValue(undefined),
    recordAgentChannelChatSucceeded: vi.fn().mockResolvedValue(undefined),
  },
  abuseControlService: { enforce: vi.fn().mockResolvedValue(undefined) },
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
    expect(dependencies.accessGrantService.resolveAgentChannelGrant).toHaveBeenCalledWith("rest-agent-secret", "agent-api");
    expect(dependencies.accessGrantService.touchGrant).toHaveBeenCalledWith(grant().id);
    expect(dependencies.accessGrantService.recordAgentChannelChatSucceeded).toHaveBeenCalledWith({
      grant: expect.objectContaining({ id: grant().id, agentId, workspaceId, channel: "agent-api" }),
    });
    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "agent.channel.chat.grant",
      subjectKey: `grant:${grant().id}`,
    }));
    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "agent.channel.chat.workspace",
      subjectKey: `workspace:${workspaceId}:global`,
    }));
    expect(dependencies.assistantChatService.answer).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      agentId,
      accountId: undefined,
      message: "Hello",
      sourceChannel: "agent_api",
      sourceOrigin: null,
    }));
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

  it("stops REST chat before provider work when the grant budget is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: {
        enforce: vi.fn().mockRejectedValue({ statusCode: 429, code: "rate_limit_exceeded" }),
      } as unknown as AppDependencies["abuseControlService"],
    });

    await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/chat`)
      .set("Authorization", "Bearer rest-agent-secret")
      .send({ message: "Hello" })
      .expect(429);

    expect(dependencies.assistantChatService.answer).not.toHaveBeenCalled();
  });
});
