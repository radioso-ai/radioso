import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createMcpConverseRoutes } from "../../src/app/http/routes/mcpConverseRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";

const principal = {
  workspaceId: "workspace-1",
  agentId: "agent-1",
  grantId: "grant-mcp",
  publicSessionId: "session-1",
  grantVersion: "version-1",
  sourceChannel: "mcp",
  sourceOrigin: null,
  authPrincipal: {
    type: "public_chat_session",
    role: "agent",
    workspaceId: "workspace-1",
    agentId: "agent-1",
    publicSessionId: "session-1",
  },
};

const createDependencies = (overrides: Partial<AppDependencies> = {}): AppDependencies => ({
  env: {
    AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 3,
    AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 9,
  },
  abuseControlService: { enforce: vi.fn().mockResolvedValue(undefined) },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
  accountAccessService: { requirePermission: vi.fn().mockResolvedValue(undefined) },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const sessionService = {
    validate: vi.fn().mockResolvedValue(principal),
    permissions: vi.fn().mockReturnValue([]),
  };
  const converseService = { askAgent: vi.fn().mockResolvedValue({ answer: "Hello" }) };
  const app = express();
  app.use(express.json());
  app.use("/api/v1/mcp/converse", createMcpConverseRoutes(dependencies, {
    audit: {} as never,
    sessionService: sessionService as never,
    converseService: converseService as never,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { statusCode?: number }).statusCode ?? 500).json({ code: (error as { code?: string }).code });
  });
  return { app, converseService };
};

describe("MCP converse ask rate limiting", () => {
  it("spends grant and workspace budgets before running MCP ask", async () => {
    const dependencies = createDependencies();
    const { app, converseService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: "Hello" })
      .expect(200);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "agent.channel.chat.grant",
      subjectKey: "grant:grant-mcp",
    }));
    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "agent.channel.chat.workspace",
      subjectKey: "workspace:workspace-1:global",
    }));
    expect(converseService.askAgent).toHaveBeenCalledOnce();
  });

  it("does not run MCP ask when a channel budget is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: { enforce: vi.fn().mockRejectedValue({ statusCode: 429, code: "rate_limit_exceeded" }) } as never,
    });
    const { app, converseService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: "Hello" })
      .expect(429);

    expect(converseService.askAgent).not.toHaveBeenCalled();
  });
});
