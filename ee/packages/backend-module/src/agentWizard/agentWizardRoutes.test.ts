import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAgentWizardRoutes } from "./agentWizardRoutes.js";
import {
  AgentWizardError,
  type AgentWizardService,
} from "./agentWizardService.js";
import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const createDependencies = (overrides: Partial<RouteDependencies> = {}): RouteDependencies => ({
  connectorDb: { query: vi.fn().mockResolvedValue([]) },
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
  },
  abuseControlService: {
    enforce: vi.fn().mockResolvedValue(undefined),
  },
  auditService: {
    record: vi.fn().mockResolvedValue(undefined),
  },
  authService: {
    authenticateSession: vi.fn().mockImplementation(async (token: string) => {
      if (token !== "valid-session") {
        throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      }
      return { accountId: "account-1", userId: "user-1", sessionId: "session-1" };
    }),
    authenticateApiToken: vi.fn().mockResolvedValue({ accountId: "account-1", workspaceId: "workspace-token" }),
  },
  accountAccessService: {
    requireActiveMembership: vi.fn().mockResolvedValue(undefined),
  },
  workspaceSessionService: {
    resolve: vi.fn().mockResolvedValue({ accountId: "account-1", workspaceId: "workspace-1" }),
  },
  userRepository: {
    findById: vi.fn().mockResolvedValue(null),
  },
  workspaceRepository: {
    findByAnonymousChatToken: vi.fn().mockResolvedValue(null),
  },
  ...overrides,
});

const createService = (overrides: Partial<AgentWizardService> = {}): AgentWizardService => ({
  analyzeWebsite: vi.fn().mockResolvedValue({
    suggestedName: "Example Support",
    suggestedCustomInstruction: "Help visitors understand Example.",
    suggestedGreetingMessage: "Hi! I can help with Example.",
    suggestedChunkingStrategy: {
      strategy: "structured_semantic",
      reasoning: "Structured pages.",
    },
    screenshotBase64: null,
    screenshotUnavailableReason: null,
    faviconUrl: null,
    pagesAnalyzed: [{ url: "https://example.com", title: "Example" }],
    sourceUrl: "https://example.com",
  }),
  createAgentFromWizard: vi.fn().mockResolvedValue({ agentId: "agent-1", crawlJobId: "crawl-1" }),
  ...overrides,
} as unknown as AgentWizardService);

const createApp = (
  service = createService(),
  dependencies = createDependencies(),
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
  app.use("/api/v1/ee/agent-wizard", createAgentWizardRoutes(dependencies, service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    const code = (error as { code?: string })?.code ?? "internal_error";
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(statusCode).json({ code, message });
  });
  return app;
};

describe("agent wizard routes", () => {
  it("rate limits analysis before calling the service", async () => {
    const service = createService();
    const abuseControlService = {
      enforce: vi.fn().mockRejectedValue({
        statusCode: 429,
        code: "rate_limited",
        message: "Too many analyses",
      }),
    };

    const response = await request(createApp(service, createDependencies({ abuseControlService })))
      .post("/api/v1/ee/agent-wizard/analyze-website")
      .set("Cookie", "radioso_session=valid-session")
      .send({ url: "https://example.com" })
      .expect(429);

    expect(response.body).toEqual({
      code: "rate_limited",
      message: "Too many analyses",
    });
    expect(abuseControlService.enforce).toHaveBeenCalledWith({
      scope: "agent_wizard.analyze",
      subjectKey: "workspace-1:user:user-1",
      limit: 5,
      windowMs: 3_600_000,
      blockMs: 60_000,
    });
    expect(service.analyzeWebsite).not.toHaveBeenCalled();
  });

  it("returns typed analysis errors as actionable JSON", async () => {
    const service = createService({
      analyzeWebsite: vi.fn().mockRejectedValue(new AgentWizardError(
        "authentication_required",
        "The website requires authentication before we can analyze it.",
        422,
      )),
    });

    const response = await request(createApp(service))
      .post("/api/v1/ee/agent-wizard/analyze-website")
      .set("Cookie", "radioso_session=valid-session")
      .send({ url: "https://example.com" })
      .expect(422);

    expect(response.body).toEqual({
      code: "authentication_required",
      message: "The website requires authentication before we can analyze it.",
    });
  });

  it("streams wizard progress events as SSE", async () => {
    const service = createService({
      analyzeWebsite: vi.fn().mockImplementation(async ({ onProgress }) => {
        onProgress?.({ type: "progress", step: "crawling", page: 1, total: 1, url: "https://example.com", title: "Example" });
        onProgress?.({ type: "progress", step: "analyzing" });
        return {
          suggestedName: "Example Support",
          suggestedCustomInstruction: "Help visitors understand Example.",
          suggestedGreetingMessage: "Hi! I can help with Example.",
          suggestedChunkingStrategy: {
            strategy: "structured_semantic",
            reasoning: "Structured pages.",
          },
          screenshotBase64: null,
          screenshotUnavailableReason: null,
          faviconUrl: null,
          pagesAnalyzed: [{ url: "https://example.com", title: "Example" }],
          sourceUrl: "https://example.com",
        };
      }),
    });

    const response = await request(createApp(service))
      .post("/api/v1/ee/agent-wizard/analyze-website/stream")
      .set("Cookie", "radioso_session=valid-session")
      .send({ url: "https://example.com" })
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("event: progress");
    expect(response.text).toContain("\"step\":\"crawling\"");
    expect(response.text).toContain("event: complete");
    expect(response.text).toContain("\"suggestedName\":\"Example Support\"");
  });
});
