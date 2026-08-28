import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import {
  createEvalRoutes,
  type EvalRouteDependencies,
} from "../../src/modules/eval/routes/evalRoutes.js";
import type {
  EvalMessageCaseLookup,
  EvalMessageCaseMutationResult,
} from "../../src/modules/eval/domain/types.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

const lookup = (): EvalMessageCaseLookup => ({
  assistantMessageId: ASSISTANT_MESSAGE_ID,
  case: {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: WORKSPACE_ID,
    snapshotId: "55555555-5555-4555-8555-555555555555",
    name: "Refund policy",
    assertions: [],
    status: "pending",
    lastRunId: null,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt: "2026-07-30T10:00:00.000Z",
  },
  snapshot: {
    id: "55555555-5555-4555-8555-555555555555",
    workspaceId: WORKSPACE_ID,
    sourceConversationId: "66666666-6666-4666-8666-666666666666",
    sourceMessageId: ASSISTANT_MESSAGE_ID,
    replayTarget: {
      userMessageId: "77777777-7777-4777-8777-777777777777",
      assistantMessageId: ASSISTANT_MESSAGE_ID,
    },
    fidelity: "messages_only",
    messages: [],
    originalInstructionBlock: null,
    originalModelId: null,
    originalRetrievalSettings: null,
    originalRetrievalResult: null,
    originalAgent: null,
    originalAgentConfig: null,
    sourceAgentId: null,
    originalRoutineState: null,
    capturedAt: "2026-07-30T10:00:00.000Z",
    capturedBy: null,
  },
  createdBy: null,
  createdAt: "2026-07-30T10:00:00.000Z",
});

const createApp = (input?: {
  found?: EvalMessageCaseLookup;
  mutation?: EvalMessageCaseMutationResult;
}) => {
  const get = vi.fn().mockResolvedValue(input?.found ?? lookup());
  const findOrCreate = vi.fn().mockResolvedValue(
    input?.mutation ?? { ...lookup(), created: true },
  );
  const requirePermission = vi.fn().mockResolvedValue(undefined);
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
        principal: {
          type: "workspace_api_token",
          role: "admin",
          tokenId: "token-id",
          workspaceId: WORKSPACE_ID,
        },
      }),
    },
    accountAccessService: {
      requirePermission,
    },
    workspaceSessionService: {},
    messageCaseService: { get, findOrCreate },
    snapshotService: {},
    caseService: {},
    runService: {},
    suiteService: {},
    abuseControlService: {},
    auditService: {},
  } as unknown as EvalRouteDependencies;

  const app = express();
  app.use(express.json());
  app.use("/api/v1/evals", createEvalRoutes(dependencies));
  app.use((
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return { app, get, findOrCreate, requirePermission };
};

describe("Eval message-case routes", () => {
  it("gets an existing association without creating it", async () => {
    const { app, get, findOrCreate, requirePermission } = createApp();

    const response = await request(app)
      .get(`/api/v1/evals/cases/by-source-message/${ASSISTANT_MESSAGE_ID}`)
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(lookup());
    expect(get).toHaveBeenCalledWith(WORKSPACE_ID, ASSISTANT_MESSAGE_ID);
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(requirePermission).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      permission: "workspace.retrieval.query",
    }));
  });

  it.each([
    { created: true, status: 201 },
    { created: false, status: 200 },
  ])("returns $status when created is $created", async ({ created, status }) => {
    const mutation = { ...lookup(), created };
    const { app, findOrCreate } = createApp({ mutation });

    const response = await request(app)
      .put(`/api/v1/evals/cases/by-source-message/${ASSISTANT_MESSAGE_ID}`)
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(status);
    expect(response.body).toEqual(mutation);
    expect(findOrCreate).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
      createdBy: null,
    });
  });

  it("rejects an invalid source message id before calling the service", async () => {
    const { app, get, findOrCreate } = createApp();

    const response = await request(app)
      .put("/api/v1/evals/cases/by-source-message/not-a-uuid")
      .set("authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: "bad_request" },
    });
    expect(get).not.toHaveBeenCalled();
    expect(findOrCreate).not.toHaveBeenCalled();
  });
});
