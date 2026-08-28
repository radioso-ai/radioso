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
  const deleteCase = vi.fn();
  const getWithRuns = vi.fn();
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
    caseService: { rename, replaceAssertions, delete: deleteCase, getWithRuns },
    runService: {},
    suiteService: {},
    abuseControlService: {},
    auditService: { record: vi.fn().mockResolvedValue(undefined) },
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
  return { app, getById, rename, replaceAssertions, deleteCase, getWithRuns };
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
