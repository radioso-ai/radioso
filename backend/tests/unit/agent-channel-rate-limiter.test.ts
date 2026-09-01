import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { agentChannelChatRateLimiters } from "../../src/app/http/middleware/agentChannelRateLimiter.js";

const dependencies = (enforce = vi.fn().mockResolvedValue(undefined)) => ({
  env: {
    AGENT_CHANNEL_CHAT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 3,
    AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 9,
  },
  abuseControlService: { enforce },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
});

const run = async (audience: "rest" | "mcp", locals: Record<string, unknown>, enforce = vi.fn().mockResolvedValue(undefined)) => {
  const middlewares = agentChannelChatRateLimiters(dependencies(enforce), audience);
  const req = {} as Request;
  const res = { locals } as Response;
  const next = vi.fn() as unknown as NextFunction;
  for (const middleware of middlewares) {
    await middleware(req, res, next);
    if ((next as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]) break;
  }
  return { enforce, next };
};

describe("agent channel chat rate limiter", () => {
  it("spends both the per-grant and workspace-global budget for REST agent chat", async () => {
    const { enforce } = await run("rest", {
      agentChannelGrant: { id: "grant-rest", workspaceId: "workspace-1", agentId: "agent-1" },
    });

    expect(enforce).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "agent.channel.chat.grant",
      subjectKey: "grant:grant-rest",
    }));
    expect(enforce).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "agent.channel.chat.workspace",
      subjectKey: "workspace:workspace-1:global",
    }));
  });

  it("spends the same two durable budgets for MCP ask using the session-bound grant", async () => {
    const { enforce } = await run("mcp", {
      mcpConversePrincipal: { grantId: "grant-mcp", workspaceId: "workspace-1", agentId: "agent-1" },
    });

    expect(enforce).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "agent.channel.chat.grant",
      subjectKey: "grant:grant-mcp",
    }));
    expect(enforce).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "agent.channel.chat.workspace",
      subjectKey: "workspace:workspace-1:global",
    }));
  });
});
