import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  createQualityRoutes,
  type QualityRouteDependencies,
  type QualityServicePort,
} from "../../src/modules/quality/routes.js";
import type {
  ListLowQualityTurnsInput,
  LowQualityTurnsPage,
  QualityStats,
  QualityStatsInput,
  QualityTriageRecord,
  SetTriageStateResult,
  SetTriageStateInput,
} from "../../src/modules/quality/contracts/index.js";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

const DEFAULT_TRIAGE_RESULT: QualityTriageRecord = {
  state: "resolved",
  version: 3,
  resolution: { reason: "knowledge_gap", note: "Fixed" },
  legacyReason: null,
  closedAt: "2026-05-23T10:00:00.000Z",
  updatedAt: "2026-05-23T10:00:00.000Z",
};

const emptyMetric = { count: 0, denominator: 0, rate: null };
const emptyWindow = {
  from: "2026-06-28T00:00:00.000Z",
  to: "2026-07-28T00:00:00.000Z",
  turnCount: 0,
  grounded: emptyMetric,
  negativeFeedback: emptyMetric,
  skillFailures: emptyMetric,
};

const DEFAULT_STATS: QualityStats = {
  range: "30d",
  filters: {},
  current: emptyWindow,
  previous: emptyWindow,
  buckets: [],
  backlog: {
    negative_feedback: 3,
    grounding_gaps: 7,
    skill_failures: 0,
  },
  resolutionBreakdown: [],
};

class CapturingService implements QualityServicePort {
  readonly calls: Array<{ workspaceId: string; input: ListLowQualityTurnsInput }> = [];
  readonly triageCalls: Array<{ workspaceId: string; input: SetTriageStateInput }> = [];
  readonly statsCalls: Array<{ workspaceId: string; input: QualityStatsInput }> = [];

  constructor(
    private readonly page: LowQualityTurnsPage,
    private readonly triageResult: SetTriageStateResult = {
      kind: "updated",
      record: DEFAULT_TRIAGE_RESULT,
    },
    private readonly stats: QualityStats = DEFAULT_STATS,
  ) {}

  async listLowQualityTurns(workspaceId: string, input: ListLowQualityTurnsInput): Promise<LowQualityTurnsPage> {
    this.calls.push({ workspaceId, input });
    return this.page;
  }

  async setTriageState(workspaceId: string, input: SetTriageStateInput): Promise<SetTriageStateResult> {
    this.triageCalls.push({ workspaceId, input });
    return this.triageResult;
  }

  async getQualityStats(workspaceId: string, input: QualityStatsInput): Promise<QualityStats> {
    this.statsCalls.push({ workspaceId, input });
    return this.stats;
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
    logger: {
      info() {},
      warn() {},
    },
    workspaceSessionService: {
      async resolve() {
        return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID };
      },
    },
  }) as unknown as QualityRouteDependencies;

const createApp = (service: QualityServicePort) => {
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
          agentInternalName: null,
          channel: "embed",
          question: "Why?",
          answerPreview: "Because.",
          skillName: "retrieval.answer",
          skillOutcome: "no_context",
          skillStatus: "completed",
          totalLatencyMs: 3200,
          grounding: {
            verdict: "no_support",
            claimCount: 0,
            sourcedClaimCount: 0,
            unsourcedClaimCount: 0,
            invalidSourceCount: 0,
          },
          createdAt: "2026-05-22T10:00:00.000Z",
          feedback: {
            upCount: 0,
            downCount: 1,
            latestDownUpdatedAt: "2026-05-22T10:05:00.000Z",
            comments: [],
          },
          triage: {
            state: "open",
            version: 0,
            resolution: null,
            legacyReason: null,
            closedAt: null,
            updatedAt: null,
          },
          verification: null,
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
        sort: "negative_feedback_updated_at",
        activeNegativeFeedbackOnly: "true",
        hasComment: "true",
        minTotalLatencyMs: "2000",
        maxTotalLatencyMs: "10000",
        channel: "embed",
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-23T00:00:00.000Z",
        resolutionReason: "knowledge_gap,unspecified",
        resolutionFrom: "2026-05-05T00:00:00.000Z",
        resolutionTo: "2026-05-24T00:00:00.000Z",
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
      sort: "negative_feedback_updated_at",
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      minTotalLatencyMs: 2000,
      maxTotalLatencyMs: 10000,
      channel: "embed",
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-23T00:00:00.000Z",
      resolutionReasons: ["knowledge_gap", "unspecified"],
      resolutionFrom: "2026-05-05T00:00:00.000Z",
      resolutionTo: "2026-05-24T00:00:00.000Z",
      limit: 10,
      offset: 20,
    });
  });

  it("forwards hasComment=false from the query string", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ hasComment: "false" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      hasComment: false,
      limit: 25,
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

  it("forwards triage-state filters from the query string", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ triage: "open,resolved" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input.triageStates).toEqual(["open", "resolved"]);
  });

  it("rejects an unknown triage-state filter with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ triage: "bogus" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("rejects an unknown quality-turn sort with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ sort: "feedback_count" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("sets structured triage state for an authenticated session caller", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send({
        state: "resolved",
        expectedVersion: 2,
        resolution: {
          reason: "knowledge_gap",
          note: "Added knowledge",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_TRIAGE_RESULT);
    expect(service.triageCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        input: {
          assistantMessageId: "44444444-4444-4444-4444-444444444444",
          state: "resolved",
          expectedVersion: 2,
          resolution: {
            reason: "knowledge_gap",
            note: "Added knowledge",
          },
          legacyReason: null,
          updatedBy: USER_ID,
        },
      },
    ]);
  });

  it("continues to accept the deprecated free-text reason without classifying it", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send({ state: "resolved", expectedVersion: 0, reason: "Added knowledge" });

    expect(response.status).toBe(200);
    expect(service.triageCalls[0]?.input).toMatchObject({
      expectedVersion: 0,
      resolution: null,
      legacyReason: "Added knowledge",
    });
  });

  it.each(["resolved", "dismissed"] as const)(
    "accepts a reasonless %s transition",
    async (state) => {
      const service = new CapturingService(emptyPage);
      const app = createApp(service);

      const response = await request(app)
        .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
        .set("Cookie", "radioso_session=valid-session")
        .send({ state, expectedVersion: 0 });

      expect(response.status).toBe(200);
      expect(service.triageCalls[0]?.input).toMatchObject({
        state,
        expectedVersion: 0,
        resolution: null,
        legacyReason: null,
      });
    },
  );

  it.each([
    [{
      state: "resolved",
      expectedVersion: 0,
      resolution: { reason: "expected_behavior" },
    }, "wrong resolution vocabulary"],
    [{
      state: "open",
      expectedVersion: 1,
      resolution: { reason: "knowledge_gap" },
    }, "resolution on active state"],
    [{
      state: "dismissed",
      expectedVersion: 0,
      resolution: { reason: "other", note: " " },
    }, "blank other note"],
    [{ state: "acknowledged" }, "missing expected version"],
  ])("rejects %s (%s) with 400", async (body, _description) => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send(body);

    expect(response.status).toBe(400);
    expect(service.triageCalls).toHaveLength(0);
  });

  it("returns 409 with the current triage record for a stale transition", async () => {
    const service = new CapturingService(emptyPage, {
      kind: "conflict",
      current: DEFAULT_TRIAGE_RESULT,
    });
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send({ state: "acknowledged", expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        code: "QUALITY_TRIAGE_CONFLICT",
        message: "Quality triage changed",
        details: { current: DEFAULT_TRIAGE_RESULT },
      },
    });
  });

  it("rejects an invalid triage state with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send({ state: "bogus" });

    expect(response.status).toBe(400);
    expect(service.triageCalls).toHaveLength(0);
  });

  it("forwards a signal filter alongside the explicit filters", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ signal: "grounding_gaps", triage: "open,acknowledged" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      signals: ["grounding_gaps"],
      triageStates: ["open", "acknowledged"],
      limit: 25,
    });
  });

  it("parses a comma-separated signal list", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ signal: "negative_feedback,grounding_gaps, skill_failures" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      signals: ["negative_feedback", "grounding_gaps", "skill_failures"],
      limit: 25,
    });
  });

  it("parses a repeated signal param", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns?signal=grounding_gaps&signal=skill_failures")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      signals: ["grounding_gaps", "skill_failures"],
      limit: 25,
    });
  });

  it("parses grounding verdicts and strict claim-presence booleans", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns?groundingVerdict=degraded&groundingVerdict=no_support")
      .query({ hasUnsourcedClaims: "false", hasInvalidSources: "true" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.calls[0]?.input).toEqual({
      groundingVerdicts: ["degraded", "no_support"],
      hasUnsourcedClaims: false,
      hasInvalidSources: true,
      limit: 25,
    });
  });

  it.each([
    ["groundingVerdict", "unknown"],
    ["hasUnsourcedClaims", "yes"],
    ["hasInvalidSources", "1"],
  ])("rejects invalid %s values", async (key, value) => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ [key]: value })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("rejects an unknown signal with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ signal: "vibes" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("rejects a signal list containing an unknown id", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/turns")
      .query({ signal: "grounding_gaps,vibes" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.calls).toHaveLength(0);
  });

  it("returns 404 when the turn is not in the workspace", async () => {
    const service = new CapturingService(emptyPage, { kind: "not_found" });
    const app = createApp(service);

    const response = await request(app)
      .put("/api/v1/quality/turns/44444444-4444-4444-4444-444444444444/triage")
      .set("Cookie", "radioso_session=valid-session")
      .send({ state: "acknowledged", expectedVersion: 0 });

    expect(response.status).toBe(404);
  });
});

describe("quality stats route", () => {
  it("rejects unauthenticated callers", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app).get("/api/v1/quality/stats");
    expect(response.status).toBe(401);
    expect(service.statsCalls).toHaveLength(0);
  });

  it("defaults to the 30d range and returns the service payload", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/stats")
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULT_STATS);
    expect(service.statsCalls).toEqual([
      { workspaceId: WORKSPACE_ID, input: { range: "30d" } },
    ]);
  });

  it("forwards the range, agent, and channel filters", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/stats")
      .query({ range: "7d", agentId: "55555555-5555-5555-5555-555555555555", channel: "embed" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(200);
    expect(service.statsCalls[0]?.input).toEqual({
      range: "7d",
      agentId: "55555555-5555-5555-5555-555555555555",
      channel: "embed",
    });
  });

  it("rejects an unsupported range with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/stats")
      .query({ range: "90d" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.statsCalls).toHaveLength(0);
  });

  it("rejects a non-uuid agent filter with 400", async () => {
    const service = new CapturingService(emptyPage);
    const app = createApp(service);

    const response = await request(app)
      .get("/api/v1/quality/stats")
      .query({ agentId: "not-a-uuid" })
      .set("Authorization", "Bearer valid-token");

    expect(response.status).toBe(400);
    expect(service.statsCalls).toHaveLength(0);
  });
});
