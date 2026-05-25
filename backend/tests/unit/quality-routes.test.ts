import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createQualityRoutes, type QualityRouteDependencies } from "../../src/modules/quality/routes.js";
import type {
  ListLowQualityTurnsInput,
  LowQualityTurnsPage,
  QualityTurnsServicePort,
} from "../../src/modules/quality/contracts/index.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

class CapturingService implements QualityTurnsServicePort {
  readonly calls: Array<{ workspaceId: string; input: ListLowQualityTurnsInput }> = [];

  constructor(private readonly page: LowQualityTurnsPage) {}

  async listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage> {
    this.calls.push({ workspaceId, input });
    return this.page;
  }
}

const createDependencies = (): QualityRouteDependencies =>
  // Narrow fake — only the surface area required by the route is implemented.
  ({
    env: {
      NODE_ENV: "test",
      SESSION_COOKIE_NAME: "radioso_session",
      SESSION_COOKIE_SECRET: "session-secret",
      WORKSPACE_TOKEN_SECRET: "workspace-secret",
    },
    authService: {
      async authenticateSession(token: string) {
        if (token !== "valid-session") {
          throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
        }
        return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" };
      },
      async authenticateApiToken(token: string) {
        if (token !== "valid-token") {
          throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
        }
        return {
          accountId: ACCOUNT_ID,
          workspaceId: WORKSPACE_ID,
          principal: { type: "workspace_api_token", role: "admin", tokenId: "token-id" },
        };
      },
    },
    accountAccessService: {
      async requireActiveMembership() {
        return undefined;
      },
      async requirePermission() {
        return undefined;
      },
    },
    workspaceSessionService: {
      async resolve() {
        return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
      },
    },
  }) as unknown as QualityRouteDependencies;

const createApp = (service: QualityTurnsServicePort) => {
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
  app.use("/api/v1/quality", createQualityRoutes(createDependencies(), service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: {
        code: payload.code ?? "internal_error",
        message: payload.message ?? "Internal error",
      },
    });
  });
  return app;
};

const emptyPage: LowQualityTurnsPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 0,
};

describe("quality routes", () => {
  it("rejects unauthenticated callers", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app).get("/api/v1/quality/turns");
    expect(response.status).toBe(401);
    expect(service.calls).toHaveLength(0);
  });

  it("returns the service page for an authenticated workspace caller", async () => {
    const page: LowQualityTurnsPage = {
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      items: [
        {
          assistantMessageId: "msg-1",
          conversationId: "conv-1",
          agentId: null,
          agentName: null,
          channel: "embed",
          question: "Why?",
          answerPreview: "Because.",
          skillName: "retrieval.answer",
          skillOutcome: "no_context",
          skillStatus: "completed",
          totalLatencyMs: 3200,
          createdAt: "2026-05-22T10:00:00.000Z",
          feedback: { upCount: 0, downCount: 1, comments: [] },
        },
      ],
    };
    const service = new CapturingService(page);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(service.calls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        input: { limit: 25 },
      },
    ]);
  });

  it("forwards filters and offset pagination from the query string", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({
        actions: "retrieval.answer:no_context,human_contact.request:sent",
        statuses: "paused,failed",
        feedback: "down",
        hasComment: "true",
        minTotalLatencyMs: "2000",
        maxTotalLatencyMs: "10000",
        channel: "embed",
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-23T00:00:00.000Z",
        limit: "10",
        offset: "20",
      })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      actions: [
        { skillName: "retrieval.answer", outcome: "no_context" },
        { skillName: "human_contact.request", outcome: "sent" },
      ],
      statuses: ["paused", "failed"],
      feedbackValues: ["down"],
      hasComment: true,
      minTotalLatencyMs: 2000,
      maxTotalLatencyMs: 10000,
      channel: "embed",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-23T00:00:00.000Z",
      limit: 10,
      offset: 20,
    });
  });

  it("rejects malformed action filter entries with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ actions: "no_colon_separator" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });
});
