import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAgentRoutes } from "../../src/app/http/routes/agentRoutes.js";
import type { AppDependencies } from "../../src/app/server/types.js";

const agentId = "22222222-2222-4222-8222-222222222222";

const createDependencies = (
  overrides: Partial<AppDependencies> = {},
): AppDependencies => ({
  env: { SESSION_COOKIE_NAME: "radioso_session" },
  authService: {
    authenticateApiToken: vi.fn().mockResolvedValue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      principal: { type: "workspace_api_token", role: "admin", tokenId: "token-1" },
    }),
  },
  accountAccessService: {
    requirePermission: vi.fn().mockResolvedValue(undefined),
  },
  workspaceSessionService: {},
  directiveAuthorService: {
    draft: vi.fn().mockResolvedValue({
      directive: {
        name: "answer-directly",
        condition: { kind: "always" },
        action: "Answer directly before adding supporting context.",
        tags: [],
      },
      diagnosis: "directive_recommended",
    }),
  },
  ...overrides,
} as unknown as AppDependencies);

const createApp = (dependencies = createDependencies()) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentRoutes(dependencies));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const statusCode = (error as { statusCode?: number })?.statusCode ?? 500;
    const code = (error as { code?: string })?.code ?? "internal_error";
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(statusCode).json({ code, message });
  });
  return app;
};

describe("agent directive draft route", () => {
  it("returns 403 when the workspace principal lacks agent management permission", async () => {
    const dependencies = createDependencies({
      accountAccessService: {
        requirePermission: vi.fn().mockRejectedValue({
          statusCode: 403,
          code: "forbidden",
          message: "You do not have permission to perform this action",
        }),
      } as unknown as AppDependencies["accountAccessService"],
    });

    const response = await request(createApp(dependencies))
      .post(`/api/v1/agents/${agentId}/directives/draft`)
      .set("Authorization", "Bearer token")
      .send({
        coachingText: "Make future answers shorter.",
        turn: {
          userMessage: "Hello",
          assistantAnswer: "A very long answer.",
        },
      })
      .expect(403);

    expect(response.body).toEqual({
      code: "forbidden",
      message: "Internal server error",
    });
    expect(dependencies.directiveAuthorService.draft).not.toHaveBeenCalled();
  });
});
