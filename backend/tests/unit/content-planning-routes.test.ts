import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  createContentPlanningRoutes,
  type ContentPlanningRouteDependencies,
} from "../../src/modules/contentPlanning/routes.js";
import type {
  ContentPlanListQuery,
  ContentPlanPage,
  ContentPlanReadServicePort,
  ContentPlanTopicDetail,
  ContentPlanTopicTurnsQuery,
} from "../../src/modules/contentPlanning/contracts/index.js";
import type { LowQualityTurnsPage } from "../../src/modules/quality/contracts/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TOPIC_ID = "33333333-3333-4333-8333-333333333333";

const emptyProjection = {
  state: "ready" as const,
  processedThrough: null,
  processingLagSeconds: null,
  pendingEmbeddingCount: 0,
  pendingAssignmentCount: 0,
  pendingEnrichmentTopicCount: 0,
  processedCount: null,
  totalCount: null,
  embeddingSpaceFingerprint: null,
  reason: null,
};

const emptyPage: ContentPlanPage = {
  range: "30d",
  window: { from: "2026-07-03T12:00:00.000Z", to: "2026-08-02T12:00:00.000Z" },
  comparisonWindow: { from: "2026-06-03T12:00:00.000Z", to: "2026-07-03T12:00:00.000Z" },
  asOf: "2026-08-02T12:00:00.000Z",
  projection: emptyProjection,
  summary: {
    questionCount: 0,
    conversationCount: 0,
    matureTopicCount: 0,
    emergingQuestionCount: 0,
    opportunityCount: 0,
    grounding: {
      evaluatedAnswerCount: 0,
      groundedAnswerCount: 0,
      degradedAnswerCount: 0,
      noSupportAnswerCount: 0,
      notEvaluatedAnswerCount: 0,
      reducedOrNoSupportRate: null,
      headlineState: "unmeasured",
    },
  },
  rankingVersion: 1,
  recommendedTopicId: null,
  items: [],
  emerging: [],
  nextCursor: null,
};

const emptyTurns: LowQualityTurnsPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 0,
};

class CapturingContentPlanService implements ContentPlanReadServicePort {
  listCalls: Array<{ workspaceId: string; query: ContentPlanListQuery }> = [];
  detailCalls: Array<{ workspaceId: string; topicId: string }> = [];
  turnCalls: Array<{ workspaceId: string; topicId: string; query: ContentPlanTopicTurnsQuery }> = [];

  constructor(
    private readonly detail: ContentPlanTopicDetail | null = null,
    private readonly turns: LowQualityTurnsPage | null = emptyTurns,
  ) {}

  async list(workspaceId: string, query: ContentPlanListQuery): Promise<ContentPlanPage> {
    this.listCalls.push({ workspaceId, query });
    return emptyPage;
  }

  async getTopic(workspaceId: string, topicId: string): Promise<ContentPlanTopicDetail | null> {
    this.detailCalls.push({ workspaceId, topicId });
    return this.detail;
  }

  async listTopicTurns(
    workspaceId: string,
    topicId: string,
    query: ContentPlanTopicTurnsQuery,
  ): Promise<LowQualityTurnsPage | null> {
    this.turnCalls.push({ workspaceId, topicId, query });
    return this.turns;
  }
}

const createDependencies = (): ContentPlanningRouteDependencies => ({
  env: {
    NODE_ENV: "test",
    SESSION_COOKIE_NAME: "radioso_session",
    SESSION_COOKIE_SECRET: "session-secret",
    WORKSPACE_TOKEN_SECRET: "workspace-secret",
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
      return { accountId: ACCOUNT_ID, userId: "user-id", sessionId: "session-id" };
    },
    async authenticateApiToken() {
      throw { statusCode: 401, code: "unauthorized", message: "Unauthorized" };
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission() {},
  },
  workspaceSessionService: {
    async resolve() {
      return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
    },
  },
  logger: { info() {}, warn() {} },
} as unknown as ContentPlanningRouteDependencies);

const createApp = (service: ContentPlanReadServicePort) => {
  const app = express();
  app.use((req, _res, next) => {
    const cookieHeader = req.header("cookie") ?? "";
    req.cookies = Object.fromEntries(cookieHeader.split(";").map((part) => part.trim().split("=")));
    next();
  });
  app.use("/api/v1/quality/content-plan", createContentPlanningRoutes(createDependencies(), service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const payload = error as { statusCode?: number; code?: string; message?: string };
    res.status(payload.statusCode ?? 500).json({
      error: { code: payload.code ?? "internal_error", message: payload.message ?? "Internal error" },
    });
  });
  return app;
};

describe("content planning routes", () => {
  it("requires an authenticated workspace Quality reader", async () => {
    const service = new CapturingContentPlanService();
    const response = await request(createApp(service)).get("/api/v1/quality/content-plan");

    expect(response.status).toBe(401);
    expect(service.listCalls).toHaveLength(0);
  });

  it("passes bounded list defaults and explicit view/cursor to the service", async () => {
    const service = new CapturingContentPlanService();
    const response = await request(createApp(service))
      .get("/api/v1/quality/content-plan?view=all_interests&cursor=opaque&limit=50")
      .set("Cookie", "radioso_session=valid-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(emptyPage);
    expect(service.listCalls).toEqual([{
      workspaceId: WORKSPACE_ID,
      query: { view: "all_interests", cursor: "opaque", limit: 50 },
    }]);
  });

  it("rejects invalid list and topic-turn queries before service calls", async () => {
    const service = new CapturingContentPlanService();
    expect((await request(createApp(service))
      .get("/api/v1/quality/content-plan?limit=101")
      .set("Cookie", "radioso_session=valid-session")).status).toBe(400);
    expect((await request(createApp(service))
      .get(`/api/v1/quality/content-plan/topics/${TOPIC_ID}/turns?page=0`)
      .set("Cookie", "radioso_session=valid-session")).status).toBe(400);
    expect(service.listCalls).toHaveLength(0);
    expect(service.turnCalls).toHaveLength(0);
  });

  it("uses indistinguishable not-found behavior for missing detail and turns", async () => {
    const service = new CapturingContentPlanService(null, null);
    const app = createApp(service);
    const detail = await request(app)
      .get(`/api/v1/quality/content-plan/topics/${TOPIC_ID}`)
      .set("Cookie", "radioso_session=valid-session");
    const turns = await request(app)
      .get(`/api/v1/quality/content-plan/topics/${TOPIC_ID}/turns`)
      .set("Cookie", "radioso_session=valid-session");

    expect(detail.status).toBe(404);
    expect(turns.status).toBe(404);
    expect(detail.body).toEqual(turns.body);
  });

  it("validates topic IDs and passes member-turn pagination", async () => {
    const service = new CapturingContentPlanService();
    const app = createApp(service);
    expect((await request(app)
      .get("/api/v1/quality/content-plan/topics/not-a-uuid")
      .set("Cookie", "radioso_session=valid-session")).status).toBe(400);

    const response = await request(app)
      .get(`/api/v1/quality/content-plan/topics/${TOPIC_ID}/turns?window=both&page=2&pageSize=10`)
      .set("Cookie", "radioso_session=valid-session");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(emptyTurns);
    expect(service.turnCalls).toEqual([{
      workspaceId: WORKSPACE_ID,
      topicId: TOPIC_ID,
      query: { window: "both", page: 2, pageSize: 10 },
    }]);
  });
});
