import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createEvalRoutes,
  type EvalRouteDependencies,
} from "../../src/modules/eval/routes/evalRoutes.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

const createApp = () => {
  const getById = vi.fn();
  const rename = vi.fn();
  const replaceAssertions = vi.fn();
  const setExecutionMode = vi.fn().mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: WORKSPACE_ID,
    snapshotId: "44444444-4444-4444-8444-444444444444",
    name: "External effect check",
    assertions: [],
    executionMode: "live",
    status: "pending",
    lastRunId: null,
    createdAt: "2026-09-02T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
  });
  const deleteCase = vi.fn();
  const getWithRuns = vi.fn();
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn() };
  const dependencies = {
    env: {
      NODE_ENV: "test",
      SESSION_COOKIE_NAME: "radioso_session",
      SESSION_COOKIE_SECRET: "session-secret",
      WORKSPACE_TOKEN_SECRET: "workspace-secret",
    },
    authService: {
      authenticateApiToken: vi.fn().mockResolvedValue({
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        principal: { type: "workspace_api_token", role: "admin", tokenId: "token-id" },
      }),
    },
    accountAccessService: { requirePermission: vi.fn().mockResolvedValue(undefined) },
    workspaceSessionService: {},
    snapshotService: { getById },
    messageCaseService: {},
    caseService: { rename, replaceAssertions, setExecutionMode, delete: deleteCase, getWithRuns },
    runService: {},
    suiteService: {},
    abuseControlService: {},
    auditService: { record: auditRecord },
    logger,
  } as unknown as EvalRouteDependencies;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/evals", createEvalRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: { code: payload.code ?? "internal_error", message: payload.message ?? "Internal error" },
    });
  });
  return { app, getById, rename, replaceAssertions, setExecutionMode, deleteCase, getWithRuns, auditRecord, logger };
};

describe("Eval route UUID parameters", () => {
  it.each([
    { method: "get", path: "/snapshots/not-a-uuid", body: undefined, service: "getById" },
    { method: "patch", path: "/cases/not-a-uuid", body: { name: "Renamed" }, service: "rename" },
    { method: "put", path: "/cases/not-a-uuid/assertions", body: { assertions: [] }, service: "replaceAssertions" },
    { method: "delete", path: "/cases/not-a-uuid", body: undefined, service: "deleteCase" },
    { method: "get", path: "/cases/not-a-uuid", body: undefined, service: "getWithRuns" },
    { method: "post", path: "/cases/not-a-uuid/runs", body: {}, service: "getWithRuns" },
  ])("rejects $method $path before calling $service", async ({ method, path, body, service }) => {
    const services = createApp();
    let response = request(services.app)[method as "get"](`/api/v1/evals${path}`)
      .set("authorization", "Bearer valid-token");
    if (body !== undefined) {
      response = response.send(body);
    }

    await response.expect(400);
    expect(services[service as keyof typeof services]).not.toHaveBeenCalled();
  });
});

it("returns the saved execution mode when its audit event cannot be recorded", async () => {
  const services = createApp();
  services.auditRecord.mockRejectedValueOnce(new Error("audit unavailable"));

  const response = await request(services.app)
    .put("/api/v1/evals/cases/33333333-3333-4333-8333-333333333333/execution-mode")
    .set("authorization", "Bearer valid-token")
    .send({ executionMode: "live" })
    .expect(200);

  expect(response.body).toMatchObject({ executionMode: "live" });
  expect(services.setExecutionMode).toHaveBeenCalledWith(
    WORKSPACE_ID,
    "33333333-3333-4333-8333-333333333333",
    "live",
  );
  expect(services.logger.warn).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: WORKSPACE_ID, executionMode: "live" }),
    "Failed to audit Eval case execution-mode update",
  );
});

it("rejects a bearer credential that tries to confirm live Eval effects", async () => {
  const services = createApp();

  await request(services.app)
    .post("/api/v1/evals/cases/33333333-3333-4333-8333-333333333333/runs")
    .set("authorization", "Bearer valid-token")
    .send({ allowLiveEffects: true })
    .expect(403);
});
