import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createMcpSourceProof, MCP_SOURCE_PROOF_HEADERS } from "@radioso/mcp-source-proof";

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
    AGENT_CHANNEL_CHAT_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 12,
    AGENT_CHANNEL_CHAT_GRANT_RATE_LIMIT_MAX_ATTEMPTS: 3,
    AGENT_CHANNEL_CHAT_WORKSPACE_RATE_LIMIT_MAX_ATTEMPTS: 9,
    MCP_CONVERSE_SESSION_RATE_LIMIT_WINDOW_MS: 60_000,
    MCP_CONVERSE_SESSION_SOURCE_RATE_LIMIT_MAX_ATTEMPTS: 60,
    MCP_CONVERSE_SESSION_TOKEN_RATE_LIMIT_MAX_ATTEMPTS: 10,
    RADIOSO_MCP_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
    RADIOSO_TRUSTED_PROXY_HOPS: 0,
  },
  abuseControlService: {
    enforce: vi.fn().mockResolvedValue(undefined),
    enforceBatch: vi.fn().mockResolvedValue(undefined),
  },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
  accountAccessService: { requirePermission: vi.fn().mockResolvedValue(undefined) },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const sessionService = {
    exchange: vi.fn().mockResolvedValue({
      sessionToken: "session-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      agent: { id: "agent-1", name: "Agent" },
      workspaceId: "workspace-1",
      agentId: "agent-1",
      publicSessionId: "public-session-1",
      grantId: "grant-mcp",
      grantVersion: "version-1",
      sourceChannel: "mcp",
      sourceOrigin: null,
      authPrincipal: principal.authPrincipal,
    }),
    validate: vi.fn().mockResolvedValue(principal),
    recordSuccessfulUse: vi.fn(),
    permissions: vi.fn().mockReturnValue([]),
  };
  const converseService = { askAgent: vi.fn().mockResolvedValue({ answer: "Hello" }) };
  const app = express();
  app.use(express.json());
  app.use("/api/v1/mcp/converse", createMcpConverseRoutes(dependencies, {
    audit: {} as never,
    sessionService: sessionService,
    converseService: converseService as never,
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { statusCode?: number }).statusCode ?? 500).json({ code: (error as { code?: string }).code });
  });
  return { app, converseService, sessionService };
};

describe("MCP converse ask rate limiting", () => {
  it("limits session exchange by source first and a digest of the launch token", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: "secret-launch-token" })
      .expect(201);

    expect(dependencies.abuseControlService.enforce).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "mcp.converse.session.source",
      subjectKey: expect.stringMatching(/^source:[A-Za-z0-9_-]+$/),
    }));
    expect(dependencies.abuseControlService.enforce).toHaveBeenNthCalledWith(2, expect.objectContaining({
      scope: "mcp.converse.session.token",
      subjectKey: expect.stringMatching(/^token:[A-Za-z0-9_-]+$/),
    }));
    expect(sessionService.recordSuccessfulUse).not.toHaveBeenCalled();
    expect(JSON.stringify((dependencies.auditService.record as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret-launch-token");
  });

  it("does not perform a token check or exchange after the source budget rejects", async () => {
    const metricsRegistry = { incrementCounter: vi.fn() };
    const dependencies = createDependencies({
      abuseControlService: {
        enforce: vi.fn().mockRejectedValue({ statusCode: 429, code: "rate_limit_exceeded" }),
        enforceBatch: vi.fn().mockResolvedValue(undefined),
      } as never,
      metricsRegistry: metricsRegistry as never,
    });
    const { app } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: "secret-launch-token" })
      .expect(429);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledOnce();
    expect(metricsRegistry.incrementCounter).toHaveBeenCalledWith(
      "mcp_converse_session_exchange_abuse_control_failures_total",
      expect.objectContaining({ labels: { stage: "source", outcome: "limited" } }),
    );
    expect(dependencies.auditService.record).not.toHaveBeenCalled();
  });

  it("spends grant and workspace budgets before running MCP ask", async () => {
    const dependencies = createDependencies();
    const { app, converseService, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: "Hello" })
      .expect(200);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "mcp.converse.session.source",
      subjectKey: expect.stringMatching(/^source:[A-Za-z0-9_-]+$/),
    }));
    expect(dependencies.abuseControlService.enforceBatch).toHaveBeenCalledWith([
      expect.objectContaining({ scope: "agent.channel.chat.grant", subjectKey: "grant:grant-mcp" }),
      expect.objectContaining({ scope: "agent.channel.chat.workspace", subjectKey: "workspace:workspace-1:global" }),
    ]);
    expect(converseService.askAgent).toHaveBeenCalledOnce();
    expect(sessionService.recordSuccessfulUse).toHaveBeenCalledWith(principal);
  });

  it("spends a source budget before validating a cached MCP session", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({ sessionToken: "bounded-session-token" })
      .expect(200);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith(expect.objectContaining({
      scope: "mcp.converse.session.source",
    }));
    expect(sessionService.validate).toHaveBeenCalledWith("bounded-session-token");
  });

  it("keeps standalone clients in distinct backend buckets using authenticated source proof", async () => {
    const dependencies = createDependencies();
    const { app } = createApp(dependencies);
    const headersFor = (sourceDigest: string) => {
      const proof = createMcpSourceProof({
        method: "POST",
        path: "/api/v1/mcp/converse/session/validate",
        secret: dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
        sourceDigest,
      });
      return {
        [MCP_SOURCE_PROOF_HEADERS.digest]: proof.sourceDigest,
        [MCP_SOURCE_PROOF_HEADERS.timestamp]: proof.timestamp,
        [MCP_SOURCE_PROOF_HEADERS.signature]: proof.signature,
      };
    };

    await request(app)
      .post("/api/v1/mcp/converse/session/validate")
      .set(headersFor("D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g"))
      .send({ sessionToken: "first" })
      .expect(200);
    await request(app)
      .post("/api/v1/mcp/converse/session/validate")
      .set(headersFor("sYp5OtRI3B9Rzkx9TQYG-CtA9w_QlKI6hB2nFPDMhqQ"))
      .send({ sessionToken: "second" })
      .expect(200);

    const sourceKeys = (dependencies.abuseControlService.enforce as ReturnType<typeof vi.fn>).mock.calls
      .map(([input]) => (input as { subjectKey: string }).subjectKey);
    expect(new Set(sourceKeys).size).toBe(2);
  });

  it("does not run MCP ask when a channel budget is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: {
        enforce: vi.fn().mockResolvedValue(undefined),
        enforceBatch: vi.fn().mockRejectedValue({ statusCode: 429, code: "rate_limit_exceeded" }),
      } as never,
    });
    const { app, converseService, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: "Hello" })
      .expect(429);

    expect(converseService.askAgent).not.toHaveBeenCalled();
    expect(sessionService.recordSuccessfulUse).not.toHaveBeenCalled();
  });

  it("does not record use when MCP ask fails", async () => {
    const dependencies = createDependencies();
    const { app, converseService, sessionService } = createApp(dependencies);
    converseService.askAgent.mockRejectedValueOnce(new Error("provider unavailable"));

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: "Hello" })
      .expect(500);

    expect(sessionService.recordSuccessfulUse).not.toHaveBeenCalled();
  });

  it("records a completed standalone MCP response through the narrow use endpoint", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);
    const path = "/api/v1/mcp/converse/session/use";
    const proof = createMcpSourceProof({
      method: "POST",
      path,
      secret: dependencies.env.RADIOSO_MCP_SIGNING_SECRET,
      sourceDigest: "D0GJ62ZQvM0QF23UXwB8Y6v6nTS26zrXbA_oYopE07g",
    });

    await request(app)
      .post(path)
      .set("Authorization", "Bearer session-token")
      .set(MCP_SOURCE_PROOF_HEADERS.digest, proof.sourceDigest)
      .set(MCP_SOURCE_PROOF_HEADERS.timestamp, proof.timestamp)
      .set(MCP_SOURCE_PROOF_HEADERS.signature, proof.signature)
      .send()
      .expect(204);

    expect(sessionService.validate).toHaveBeenCalledWith("session-token");
    expect(sessionService.recordSuccessfulUse).toHaveBeenCalledWith(principal);
  });

  it("rejects the internal use endpoint before session lookup without a valid standalone proof", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/session/use")
      .set("Authorization", "Bearer session-token")
      .send()
      .expect(403);

    expect(sessionService.validate).not.toHaveBeenCalled();
    expect(sessionService.recordSuccessfulUse).not.toHaveBeenCalled();
  });

  it("validates MCP ask before spending a channel budget", async () => {
    const dependencies = createDependencies();
    const { app, converseService, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", "Bearer session-token")
      .send({ message: 42 })
      .expect(400);

    expect(dependencies.abuseControlService.enforceBatch).not.toHaveBeenCalled();
    expect(sessionService.validate).not.toHaveBeenCalled();
    expect(dependencies.auditService.record).not.toHaveBeenCalled();
    expect(converseService.askAgent).not.toHaveBeenCalled();
  });

  it("rejects oversized validation and ask tokens before session lookup or audit", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);
    const oversized = "x".repeat(2049);

    await request(app)
      .post("/api/v1/mcp/converse/session/validate")
      .send({ sessionToken: oversized })
      .expect(400);
    await request(app)
      .post("/api/v1/mcp/converse/ask")
      .set("Authorization", `Bearer ${oversized}`)
      .send({ message: "Hello" })
      .expect(401);

    expect(sessionService.validate).not.toHaveBeenCalled();
    expect(dependencies.auditService.record).not.toHaveBeenCalled();
  });

  it("bounds MCP client metadata before exchange and audit", async () => {
    const dependencies = createDependencies();
    const { app, sessionService } = createApp(dependencies);

    await request(app)
      .post("/api/v1/mcp/converse/session")
      .send({ launchToken: "launch", client: { name: `client${"x".repeat(128)}`, version: "1.0\ncontrol" } })
      .expect(400);

    expect(sessionService.exchange).not.toHaveBeenCalled();
    expect(dependencies.auditService.record).not.toHaveBeenCalled();
  });
});
