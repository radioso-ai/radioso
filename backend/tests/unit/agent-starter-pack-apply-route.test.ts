import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";
import { defaultAnswerDirectives } from "../../src/modules/directives/public.js";
import { AppError, forbidden, notFound, tooManyRequests } from "../../src/shared/domain/errors.js";

const agentId = "22222222-2222-4222-8222-222222222222";
const path = `/api/v1/agents/${agentId}/starter-pack/apply`;

const routine = {
  enabled: true,
  name: "book-appointment",
  activation: { triggerDescription: "The visitor wants an appointment.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "step_ask", kind: "chat", instruction: "Ask for a date.", toolRef: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: "step_ask", toRef: "terminal_complete", guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: "terminal_complete", kind: "complete", instruction: "Confirm.", ordinal: 1 }],
};
const directive = (name: string) => ({ name, condition: { kind: "always" }, action: `Follow ${name}.` });
const directiveItem = (itemKey: string, name: string) => ({ itemKey, kind: "directive", directive: directive(name) });
const validBody = {
  idempotencyKey: "apply-key-0001",
  items: [directiveItem("directive-1", "confirm-details"), { itemKey: "routine-1", kind: "routine", routine }],
};

const appliedResult = {
  applyId: "33333333-3333-4333-8333-333333333333",
  items: [
    { itemKey: "directive-1", kind: "directive", id: "d-1", name: "confirm-details" },
    { itemKey: "routine-1", kind: "routine", id: "r-1", name: "book-appointment" },
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
    starterPackApplyService: { apply: vi.fn().mockResolvedValue({ ...appliedResult, replayed: false }) },
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

describe("POST /api/v1/agents/:agentId/starter-pack/apply", () => {
  it("returns 201 with the created items", async () => {
    const dependencies = createDependencies();

    const response = await post(dependencies, validBody).expect(201);

    expect(response.body).toEqual({ ...appliedResult, replayed: false });
    expect(dependencies.starterPackApplyService.apply).toHaveBeenCalledWith(
      "workspace-1",
      agentId,
      { accountId: "account-1" },
      expect.objectContaining({ idempotencyKey: "apply-key-0001", items: expect.any(Array) }),
    );
  });

  it("returns 200 when the request replays an earlier apply", async () => {
    const dependencies = createDependencies({
      starterPackApplyService: { apply: vi.fn().mockResolvedValue({ ...appliedResult, replayed: true }) },
    });

    const response = await post(dependencies, validBody).expect(200);

    expect(response.body.replayed).toBe(true);
  });

  it("accepts a pack without a routine", async () => {
    const dependencies = createDependencies();

    await post(dependencies, { idempotencyKey: "apply-key-0002", items: [directiveItem("directive-1", "confirm-details")] }).expect(201);
  });

  it("applies the wizard-style rate limit", async () => {
    const dependencies = createDependencies();

    await post(dependencies, validBody).expect(201);

    expect(dependencies.abuseControlService.enforce).toHaveBeenCalledWith({
      scope: "agent_starter_pack.apply",
      subjectKey: "workspace-1:api",
      limit: 10,
      windowMs: 3_600_000,
      blockMs: 60_000,
    });
  });

  it("returns 429 without applying when the rate limit is exhausted", async () => {
    const dependencies = createDependencies({
      abuseControlService: { enforce: vi.fn().mockRejectedValue(tooManyRequests("Too many requests")) },
    });

    await post(dependencies, validBody).expect(429);

    expect(dependencies.starterPackApplyService.apply).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", {}],
    ["a missing idempotency key", { items: validBody.items }],
    ["a too-short idempotency key", { ...validBody, idempotencyKey: "short" }],
    ["an idempotency key with spaces", { ...validBody, idempotencyKey: "has spaces in it" }],
    ["no items", { ...validBody, items: [] }],
    ["two routines", { ...validBody, items: [...validBody.items, { itemKey: "routine-2", kind: "routine", routine: { ...routine, name: "other" } }] }],
    ["seven directives", { ...validBody, items: Array.from({ length: 7 }, (_, index) => directiveItem(`d-${index}`, `rule-${index}`)) }],
    ["duplicate item keys", { ...validBody, items: [directiveItem("same", "a-rule"), directiveItem("same", "b-rule")] }],
    ["duplicate directive names", { ...validBody, items: [directiveItem("d-1", "a-rule"), directiveItem("d-2", "a-rule")] }],
    ["a directive without an action", { ...validBody, items: [{ itemKey: "d-1", kind: "directive", directive: { name: "x", condition: { kind: "always" } } }] }],
    ["a reserved built-in directive name", { ...validBody, items: [directiveItem("d-1", defaultAnswerDirectives[0].name)] }],
    ["an internal directive field", { ...validBody, items: [{ itemKey: "d-1", kind: "directive", directive: { ...directive("x-rule"), routes: ["retrieval"] } }] }],
    ["an invalid routine", { ...validBody, items: [{ itemKey: "r-1", kind: "routine", routine: { name: "broken" } }] }],
    ["an unknown item kind", { ...validBody, items: [{ itemKey: "s-1", kind: "skill", skill: {} }] }],
    ["an unknown top-level field", { ...validBody, publish: true }],
  ])("returns 400 for %s without applying or rate limiting", async (_label, body) => {
    const dependencies = createDependencies();

    const response = await post(dependencies, body).expect(400);

    expect(response.body.error.code).toBe("bad_request");
    expect(dependencies.starterPackApplyService.apply).not.toHaveBeenCalled();
    expect(dependencies.abuseControlService.enforce).not.toHaveBeenCalled();
  });

  it("returns 400 for an agent id that is not a UUID", async () => {
    const dependencies = createDependencies();

    await post(dependencies, validBody, "/api/v1/agents/not-a-uuid/starter-pack/apply").expect(400);

    expect(dependencies.starterPackApplyService.apply).not.toHaveBeenCalled();
  });

  it("returns 401 without credentials", async () => {
    const dependencies = createDependencies();

    const response = await request(createApp(dependencies)).post(path).send(validBody).expect(401);

    expect(response.body.error.code).toBe("unauthorized");
    expect(dependencies.starterPackApplyService.apply).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller cannot manage agents", async () => {
    const dependencies = createDependencies({
      accountAccessService: { requirePermission: vi.fn().mockRejectedValue(forbidden()) },
    });

    await post(dependencies, validBody).expect(403);

    expect(dependencies.accountAccessService.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "workspace.agents.manage" }),
    );
    expect(dependencies.starterPackApplyService.apply).not.toHaveBeenCalled();
  });

  it("returns 404 when the agent is not in the caller's workspace", async () => {
    const dependencies = createDependencies({
      starterPackApplyService: { apply: vi.fn().mockRejectedValue(notFound("Agent not found")) },
    });

    const response = await post(dependencies, validBody).expect(404);

    expect(response.body.error.code).toBe("not_found");
  });

  it.each([
    ["starter_pack_name_conflict"],
    ["idempotency_key_reused"],
  ])("returns 409 %s from the service in the standard error format", async (code) => {
    const dependencies = createDependencies({
      starterPackApplyService: {
        apply: vi.fn().mockRejectedValue(new AppError(409, code, "Conflict.", { items: [{ itemKey: "directive-1" }] })),
      },
    });

    const response = await post(dependencies, validBody).expect(409);

    expect(response.body).toEqual({ error: { code, message: "Conflict.", details: { items: [{ itemKey: "directive-1" }] } } });
  });
});
