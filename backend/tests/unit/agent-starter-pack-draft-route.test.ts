import type { AddressInfo } from "node:net";
import http from "node:http";

import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { AppError, forbidden, notFound, tooManyRequests } from "../../src/shared/domain/errors.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const path = `/api/v1/agents/${agentId}/starter-pack/draft`;

const draftResult = {
  outputLanguage: "German",
  items: [
    {
      itemKey: "directive-1",
      kind: "directive",
      directive: { name: "termindetails-bestaetigen", condition: { kind: "always" }, action: "Bitte um Bestätigung." },
      conflict: null,
    },
    {
      itemKey: "routine-1",
      kind: "routine",
      routine: { name: "termin-buchen", activation: { triggerDescription: "Termin", priority: 50 }, steps: [] },
      procedure: "Frage nach Wunschtermin und buche.",
      validation: { diagnostics: [] },
      conflict: null,
    },
  ],
};

const createDependencies = (overrides: Record<string, unknown> = {}) => {
  const dependencies = {
    env: { SESSION_COOKIE_NAME: "radioso_session" },
    authService: {
      authenticateApiToken: vi.fn().mockResolvedValue({
        accountId: "account-1",
        workspaceId: "workspace-1",
        principal: { type: "workspace_api_token", role: "admin", tokenId: "token-1", workspaceId: "workspace-1" },
      }),
      recordApiTokenUse: vi.fn().mockResolvedValue(undefined),
    },
    accountAccessService: { requirePermission: vi.fn().mockResolvedValue(undefined) },
    workspaceSessionService: {},
    abuseControlService: { enforce: vi.fn().mockResolvedValue(undefined) },
    // The service runs `beforeModelCalls` once the agent exists and a chat model is configured.
    starterPackDraftService: { draft: vi.fn(async (_workspaceId: string, _agentId: string, _purpose: string, options: { beforeModelCalls?: () => Promise<void> }) => {
      await options.beforeModelCalls?.();
      return draftResult;
    }) },
    authoredDirectiveService: { create: vi.fn(), update: vi.fn() },
    routineDefinitionService: { createDraft: vi.fn(), updateDraft: vi.fn() },
    agentRevisionService: { publish: vi.fn() },
    ...overrides,
  };
  return dependencies as typeof dependencies & AppDependencies;
};

const createApp = (dependencies: AppDependencies) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use(createErrorHandler());
  return app;
};

const post = (dependencies: AppDependencies, body: unknown, url = path) =>
  request(createApp(dependencies)).post(url).set("Authorization", "Bearer token").send(body as object);

describe("POST /api/v1/agents/:agentId/starter-pack/draft", () => {
  it("returns the drafted directives and exactly one routine", async () => {
    const dependencies = createDependencies();

    const response = await post(dependencies, { purpose: "  Hilf Besuchern, Termine zu buchen.  " }).expect(200);

    expect(response.body).toEqual(draftResult);
    expect(response.body.items.filter((item: { kind: string }) => item.kind === "routine")).toHaveLength(1);
    expect(response.body.outputLanguage).toBe("German");
    expect(dependencies.starterPackDraftService.draft).toHaveBeenCalledWith(
      "workspace-1",
      agentId,
      "Hilf Besuchern, Termine zu buchen.",
      expect.objectContaining({ signal: expect.any(AbortSignal), beforeModelCalls: expect.any(Function) }),
    );
  });

  it("spends the draft rate limit per workspace user or API caller, just before the model calls", async () => {
    const dependencies = createDependencies();

    await post(dependencies, { purpose: "Help visitors book appointments." }).expect(200);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith({
      scope: "agent_starter_pack.draft",
      subjectKey: "workspace-1:api",
      limit: 5,
      windowMs: 3_600_000,
      blockMs: 60_000,
    });
  });

  it("logs a failure that is not an abort even when the client has already disconnected", async () => {
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    let fail!: (error: unknown) => void;
    const gate = new Promise<never>((_resolve, reject) => { fail = reject; });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const dependencies = createDependencies({
      logger,
      starterPackDraftService: { draft: vi.fn(async () => { release(); return gate; }) },
    });
    const server = createApp(dependencies).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const body = JSON.stringify({ purpose: "Help visitors book appointments." });
      const clientRequest = http.request({
        port,
        method: "POST",
        path,
        headers: { Authorization: "Bearer token", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      });
      clientRequest.on("error", () => undefined);
      clientRequest.end(body);
      await started;
      clientRequest.destroy();
      // Let the server see the close before the draft fails.
      await new Promise((resolve) => setTimeout(resolve, 50));
      fail(new TypeError("secret"));
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: "TypeError" }),
        "starter_pack_draft_failed_after_disconnect",
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
    } finally {
      server.close();
    }
  });

  it("returns 429 when the rate limit is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: { enforce: vi.fn().mockRejectedValue(tooManyRequests("Too many requests", { retryAfterSeconds: 60 })) },
    });

    const response = await post(dependencies, { purpose: "Help visitors book appointments." }).expect(429);

    expect(response.body.error.code).toBe("rate_limit_exceeded");
  });

  it.each([
    ["missing", {}],
    ["empty", { purpose: "" }],
    ["whitespace only", { purpose: "   " }],
    ["too long", { purpose: "x".repeat(4_001) }],
    ["not a string", { purpose: 42 }],
    ["with unknown fields", { purpose: "Help visitors.", publish: true }],
  ])("returns 400 for a %s purpose without drafting or rate limiting", async (_label, body) => {
    const dependencies = createDependencies();

    const response = await post(dependencies, body).expect(400);

    expect(response.body.error.code).toBe("bad_request");
    expect(dependencies.starterPackDraftService.draft).not.toHaveBeenCalled();
    expect(dependencies.abuseControlService.enforce).not.toHaveBeenCalled();
  });

  it("returns 400 for an agent id that is not a UUID", async () => {
    const dependencies = createDependencies();

    const response = await post(dependencies, { purpose: "Help visitors." }, "/api/v1/agents/not-a-uuid/starter-pack/draft")
      .expect(400);

    expect(response.body.error.code).toBe("bad_request");
    expect(dependencies.starterPackDraftService.draft).not.toHaveBeenCalled();
  });

  it("returns 401 without credentials", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies)).post(path).send({ purpose: "Help visitors." }).expect(401);

    expect(response.body.error.code).toBe("unauthorized");
    expect(dependencies.starterPackDraftService.draft).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller cannot manage agents", async () => {
    const dependencies = createDependencies({
      accountAccessService: { requirePermission: vi.fn().mockRejectedValue(forbidden()) },
    });

    const response = await post(dependencies, { purpose: "Help visitors." }).expect(403);

    expect(response.body.error.code).toBe("forbidden");
    expect(dependencies.accountAccessService.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "workspace.agents.manage" }),
    );
    expect(dependencies.starterPackDraftService.draft).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent does not exist in the workspace", async () => {
    const dependencies = createDependencies({
      starterPackDraftService: { draft: vi.fn().mockRejectedValue(notFound("Agent not found")) },
    });

    const response = await post(dependencies, { purpose: "Help visitors." }).expect(404);

    expect(response.body.error).toMatchObject({ code: "not_found", message: "Agent not found" });
    expect(dependencies.abuseControlService.enforce).not.toHaveBeenCalled();
  });

  it("returns 503 provider_misconfigured when no LLM is configured", async () => {
    const dependencies = createDependencies({
      starterPackDraftService: {
        draft: vi.fn().mockRejectedValue(new ProviderConfigurationError("No chat model is configured.", {
          kind: "missing_api_key",
          capability: "chat",
        })),
      },
    });

    const response = await post(dependencies, { purpose: "Help visitors." }).expect(503);

    expect(response.body.error).toMatchObject({
      code: "provider_misconfigured",
      details: { kind: "missing_api_key", capability: "chat" },
    });
    expect(dependencies.abuseControlService.enforce).not.toHaveBeenCalled();
  });

  it("returns 503 llm_unavailable when the model call fails", async () => {
    const dependencies = createDependencies({
      starterPackDraftService: {
        draft: vi.fn().mockRejectedValue(new AppError(503, "llm_unavailable", "The language model is unavailable.")),
      },
    });

    const response = await post(dependencies, { purpose: "Help visitors." }).expect(503);

    expect(response.body.error.code).toBe("llm_unavailable");
  });

  it("returns 422 when the model output never becomes a valid pack", async () => {
    const dependencies = createDependencies({
      starterPackDraftService: {
        draft: vi.fn().mockRejectedValue(new AppError(422, "invalid_starter_pack_draft", "Could not draft.")),
      },
    });

    const response = await post(dependencies, { purpose: "Help visitors." }).expect(422);

    expect(response.body.error.code).toBe("invalid_starter_pack_draft");
  });

  it("does not persist, apply, or publish anything", async () => {
    const dependencies = createDependencies();

    await post(dependencies, { purpose: "Help visitors book appointments." }).expect(200);

    expect(dependencies.authoredDirectiveService.create).not.toHaveBeenCalled();
    expect(dependencies.authoredDirectiveService.update).not.toHaveBeenCalled();
    expect(dependencies.routineDefinitionService.createDraft).not.toHaveBeenCalled();
    expect(dependencies.routineDefinitionService.updateDraft).not.toHaveBeenCalled();
    expect(dependencies.agentRevisionService.publish).not.toHaveBeenCalled();
  });
});
