import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  createAudiencePulseRoutes,
  type AudiencePulseRouteDependencies,
} from "../../../src/modules/audiencePulse/routes.js";
import type { AudiencePulseEvidenceAnchor, AudiencePulsePort } from "../../../src/modules/audiencePulse/contracts.js";
import type {
  AudiencePulseReadResult,
  AudiencePulseRefreshResult,
  AudiencePulseTopicDraftLink,
  AudiencePulseTopicStateWrite,
} from "../../../src/modules/audiencePulse/contracts.js";

const ACCOUNT_ID = "22222222-2222-2222-8222-222222222222";
const USER_ID = "33333333-3333-3333-8333-333333333333";
const WORKSPACE_ID = "11111111-1111-1111-8111-111111111111";
const TOPIC_ID = "66666666-6666-4666-8666-666666666666";
const DOCUMENT_ID = "77777777-7777-4777-8777-777777777777";

type TopicAction = { accountId: string; userId: string; workspaceId: string; topicId: string; documentId?: string };

class CapturingService implements AudiencePulsePort {
  reads = 0;
  refreshes = 0;
  refreshStatuses = 0;
  refreshSignalAborted: boolean | undefined;
  anchors: Array<{ accountId: string; userId: string; workspaceId: string; conversationId: string; messageId: string }> = [];
  topicActions: Array<{ action: "dismiss" | "restore" | "draft"; input: TopicAction }> = [];
  topicWrite: AudiencePulseTopicStateWrite = "changed";
  draftLink: AudiencePulseTopicDraftLink = "changed";

  async dismissTopic(input: TopicAction): Promise<AudiencePulseTopicStateWrite> {
    this.topicActions.push({ action: "dismiss", input });
    return this.topicWrite;
  }

  async restoreTopic(input: TopicAction): Promise<AudiencePulseTopicStateWrite> {
    this.topicActions.push({ action: "restore", input });
    return this.topicWrite;
  }

  async linkTopicDraft(input: TopicAction & { documentId: string }): Promise<AudiencePulseTopicDraftLink> {
    this.topicActions.push({ action: "draft", input });
    return this.draftLink;
  }

  async read(): Promise<AudiencePulseReadResult> {
    this.reads += 1;
    return { kind: "not_generated" } as const;
  }

  async refresh(input: Parameters<AudiencePulsePort["refresh"]>[0]): Promise<AudiencePulseRefreshResult> {
    this.refreshes += 1;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.refreshSignalAborted = input.signal?.aborted ?? false;
    return {
      kind: "no_traffic",
      period: { start: "2026-07-01T00:00:00.000Z", end: "2026-07-31T00:00:00.000Z" },
      weeklyVolume: [],
    };
  }

  async refreshStatus(): Promise<{ pending: boolean }> {
    this.refreshStatuses += 1;
    return { pending: false };
  }

  async readEvidenceAnchor(input: {
    accountId: string;
    userId: string;
    workspaceId: string;
    conversationId: string;
    messageId: string;
  }): Promise<AudiencePulseEvidenceAnchor | null> {
    this.anchors.push(input);
    return {
      conversationId: input.conversationId,
      source: {
        messageId: input.messageId,
        role: "user" as const,
        source: "customer" as const,
        content: "Which plan includes exports?",
        photoCount: 0,
        createdAt: "2026-07-15T10:00:00.000Z",
      },
      nextAssistant: null,
    };
  }
}

const createDependencies = (calls: { bearer: number; permission: number; rate: number; permissions: string[] }): AudiencePulseRouteDependencies => ({
  env: {
    SESSION_COOKIE_NAME: "radioso_session",
  },
  authService: {
    async authenticateSession(token: string) {
      if (token !== "valid-session") throw Object.assign(new Error("Unauthorized"), { statusCode: 401, code: "unauthorized" });
      return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" };
    },
    async authenticateApiToken() {
      calls.bearer += 1;
      return {
        accountId: ACCOUNT_ID,
        workspaceId: WORKSPACE_ID,
        principal: { type: "workspace_api_token", role: "admin", tokenId: "token-id", workspaceId: WORKSPACE_ID },
      };
    },
  },
  accountAccessService: {
    async requireActiveMembership() {},
    async requirePermission(input: { permission: string }) {
      calls.permission += 1;
      calls.permissions.push(input.permission);
    },
  },
  workspaceSessionService: {
    async resolve() { return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID }; },
  },
  abuseControlService: {
    async enforce() { calls.rate += 1; },
  },
  auditService: { async record() {} },
}) as unknown as AudiencePulseRouteDependencies;

const createApp = (service: CapturingService, calls: { bearer: number; permission: number; rate: number; permissions: string[] }) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(
      (req.header("cookie") ?? "").split(";").map((part) => part.trim().split("=")).filter(
        (part): part is [string, string] => part.length === 2,
      ),
    );
    next();
  });
  app.use("/api/v1/quality/audience-pulse", createAudiencePulseRoutes(createDependencies(calls), service));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = error as { statusCode?: number; code?: string; message?: string };
    res.status(appError.statusCode ?? 500).json({ error: { code: appError.code ?? "internal_error" } });
  });
  return app;
};

describe("Audience Pulse routes", () => {
  it("rejects a bearer request before token auth, permission, rate limiting, or service execution", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse")
      .set("Authorization", "Bearer api-token");

    expect(response.status).toBe(401);
    expect(calls).toEqual({ bearer: 0, permission: 0, rate: 0, permissions: [] });
    expect(service.refreshes).toBe(0);
  });

  it("rejects case-insensitive bearer schemes even when a session cookie is present", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    const response = await request(createApp(service, calls))
      .get("/api/v1/quality/audience-pulse")
      .set("Authorization", "bearer api-token")
      .set("Cookie", "radioso_session=valid-session");

    expect(response.status).toBe(401);
    expect(calls).toEqual({ bearer: 0, permission: 0, rate: 0, permissions: [] });
    expect(service.reads).toBe(0);
  });

  it("uses a browser session for saved reads and does not invoke the refresh rate limit", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    const response = await request(createApp(service, calls))
      .get("/api/v1/quality/audience-pulse")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ kind: "not_generated" });
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.quality.read"] });
    expect(service.reads).toBe(1);
  });

  it("delegates a session-authorized refresh without charging an HTTP rate-limit budget", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    expect(response.status).toBe(200);
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.quality.read"] });
    expect(service.refreshes).toBe(1);
    expect(service.refreshSignalAborted).toBe(false);
  });

  it("does not charge a refresh budget when the service reports an in-progress refresh", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    service.refresh = async () => {
      service.refreshes += 1;
      return { kind: "busy" };
    };

    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        code: "AUDIENCE_PULSE_REFRESH_IN_PROGRESS",
        message: "Audience Pulse refresh is already in progress",
      },
    });
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.quality.read"] });
    expect(service.refreshes).toBe(1);
  });

  it("returns 500 when refresh accounting fails instead of reporting an unavailable result", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    service.refresh = async () => {
      service.refreshes += 1;
      throw new Error("usage release failed");
    };

    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "internal_error" } });
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.quality.read"] });
    expect(service.refreshes).toBe(1);
  });

  it("returns durable preparation status through the dashboard quality permission", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();

    const response = await request(createApp(service, calls))
      .get("/api/v1/quality/audience-pulse/refresh-status")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ pending: false });
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.quality.read"] });
    expect(service.refreshStatuses).toBe(1);
  });

  it("uses a dashboard session and history permission for a body-only bounded evidence anchor", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    const conversationId = "44444444-4444-4444-8444-444444444444";
    const messageId = "55555555-5555-4555-8555-555555555555";

    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse/evidence-anchor")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID)
      .send({ conversationId, messageId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      conversationId,
      source: { messageId, content: "Which plan includes exports?" },
      nextAssistant: null,
    });
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.history.read"] });
    expect(service.anchors).toEqual([{
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      conversationId,
      messageId,
    }]);
  });

  it("rejects bearer access to the evidence anchor before history authorization or service work", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();

    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse/evidence-anchor")
      .set("Authorization", "Bearer api-token")
      .send({
        conversationId: "44444444-4444-4444-8444-444444444444",
        messageId: "55555555-5555-4555-8555-555555555555",
      });

    expect(response.status).toBe(401);
    expect(calls).toEqual({ bearer: 0, permission: 0, rate: 0, permissions: [] });
    expect(service.anchors).toEqual([]);
  });

  it("returns 404 when the exact source is not in the selected workspace conversation", async () => {
    const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
    const service = new CapturingService();
    service.readEvidenceAnchor = async () => null;

    const response = await request(createApp(service, calls))
      .post("/api/v1/quality/audience-pulse/evidence-anchor")
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID)
      .send({
        conversationId: "44444444-4444-4444-8444-444444444444",
        messageId: "55555555-5555-4555-8555-555555555555",
      });

    expect(response.status).toBe(404);
    expect(calls).toEqual({ bearer: 0, permission: 1, rate: 0, permissions: ["workspace.history.read"] });
  });

  describe("operator state on topics", () => {
    const session = (test: request.Test) => test
      .set("Cookie", "radioso_session=valid-session")
      .set("X-Workspace-Id", WORKSPACE_ID);

    it.each([
      ["put", "dismiss"],
      ["delete", "restore"],
    ] as const)("answers %s on a topic's dismissal with 204 under the quality manage permission", async (method, action) => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();

      const response = await session(request(createApp(service, calls))[method](`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/dismissal`));

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
      expect(calls.permissions).toEqual(["workspace.quality.manage"]);
      expect(service.topicActions).toEqual([{
        action,
        input: { accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, topicId: TOPIC_ID },
      }]);
    });

    it("answers a repeated dismissal with 204 too", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();
      service.topicWrite = "unchanged";

      const response = await session(request(createApp(service, calls)).put(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/dismissal`));

      expect(response.status).toBe(204);
    });

    it("answers a malformed topic id with 400 before any service work", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();

      const dismiss = await session(request(createApp(service, calls)).put("/api/v1/quality/audience-pulse/topics/not-a-uuid/dismissal"));
      const draft = await session(request(createApp(service, calls)).post("/api/v1/quality/audience-pulse/topics/not-a-uuid/drafts"))
        .send({ documentId: DOCUMENT_ID });

      expect(dismiss.status).toBe(400);
      expect(draft.status).toBe(400);
      expect(service.topicActions).toEqual([]);
    });

    it("answers a topic outside the workspace with 404", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();
      service.topicWrite = "topic_not_found";
      service.draftLink = "topic_not_found";

      const restore = await session(request(createApp(service, calls)).delete(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/dismissal`));
      const draft = await session(request(createApp(service, calls)).post(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/drafts`))
        .send({ documentId: DOCUMENT_ID });

      expect(restore.status).toBe(404);
      expect(draft.status).toBe(404);
    });

    it("links a draft document with 204 under the documents manage permission", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();

      const response = await session(request(createApp(service, calls)).post(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/drafts`))
        .send({ documentId: DOCUMENT_ID });

      expect(response.status).toBe(204);
      expect(calls.permissions).toEqual(["workspace.documents.manage"]);
      expect(service.topicActions).toEqual([{
        action: "draft",
        input: { accountId: ACCOUNT_ID, userId: USER_ID, workspaceId: WORKSPACE_ID, topicId: TOPIC_ID, documentId: DOCUMENT_ID },
      }]);
    });

    it("answers a malformed draft body with 400 and a document outside the workspace with 404", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();
      const app = createApp(service, calls);

      const missing = await session(request(app).post(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/drafts`)).send({});
      const extra = await session(request(app).post(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/drafts`))
        .send({ documentId: DOCUMENT_ID, title: "Opening hours" });
      expect(missing.status).toBe(400);
      expect(extra.status).toBe(400);
      expect(service.topicActions).toEqual([]);

      service.draftLink = "document_not_found";
      const foreign = await session(request(app).post(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/drafts`))
        .send({ documentId: DOCUMENT_ID });
      expect(foreign.status).toBe(404);
    });

    it("rejects bearer access before authorization or service work", async () => {
      const calls = { bearer: 0, permission: 0, rate: 0, permissions: [] as string[] };
      const service = new CapturingService();

      const response = await request(createApp(service, calls))
        .put(`/api/v1/quality/audience-pulse/topics/${TOPIC_ID}/dismissal`)
        .set("Authorization", "Bearer api-token");

      expect(response.status).toBe(401);
      expect(calls).toEqual({ bearer: 0, permission: 0, rate: 0, permissions: [] });
      expect(service.topicActions).toEqual([]);
    });
  });
});
