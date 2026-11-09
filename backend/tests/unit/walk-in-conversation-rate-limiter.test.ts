import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { admittedAbuseControlDecision } from "../support/fakes.js";
import {
  createMcpConverseWalkInRateLimiter,
  createWalkInConversationRateLimiter,
} from "../../src/app/http/middleware/mcpConverseWalkInRateLimiter.js";
import { readPreAuthSourceDigest } from "../../src/app/http/middleware/preAuthSourceRateLimiter.js";

const PUBLIC_ID = "ag_0123456789abcdefghijkl";

const createDependencies = (enforce = vi.fn().mockResolvedValue(admittedAbuseControlDecision())) => ({
  env: { RADIOSO_MCP_SIGNING_SECRET: "0123456789abcdef0123456789abcdef" },
  abuseControlService: { enforce },
  agentRepository: {
    findByPublicId: vi.fn().mockResolvedValue({
      id: "agent-1",
      workspaceId: "workspace-1",
      walkInConversationsPerHour: 5,
    }),
  },
  auditService: { record: vi.fn().mockResolvedValue(undefined) },
});

type Dependencies = ReturnType<typeof createDependencies>;

const spentBudgets = (dependencies: Dependencies) =>
  dependencies.abuseControlService.enforce.mock.calls
    .map(([policy]) => policy as { scope: string; subjectKey: string; limit: number });

const withErrorHandler = (app: express.Express) => {
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { statusCode?: number }).statusCode ?? 500).end();
  });
  return app;
};

/** A door that names its walk-in target in the path, opening only when the body carries no context. */
const createPathDoorApp = (dependencies: Dependencies, observer = { record: vi.fn() }) => {
  const app = express();
  app.use(express.json());
  app.post(
    "/doors/:publicId",
    createWalkInConversationRateLimiter(dependencies as never, {
      surface: "a2a_walk_in",
      walkInPublicId: (req) => {
        const publicId = req.params.publicId;
        return req.body?.contextId || typeof publicId !== "string" ? null : publicId;
      },
    }, observer),
    (_req, res) => {
      res.status(200).json({ sourceDigest: readPreAuthSourceDigest(res) ?? null });
    },
  );
  return withErrorHandler(app);
};

const createMcpDoorApp = (dependencies: Dependencies) => {
  const app = express();
  app.use(express.json());
  app.post("/session", createMcpConverseWalkInRateLimiter(dependencies as never), (_req, res) => {
    res.status(201).end();
  });
  return withErrorHandler(app);
};

describe("walk-in conversation rate limiter", () => {
  it("spends the same per-source, per-agent, and backstop budgets as the MCP walk-in exchange", async () => {
    const viaMcp = createDependencies();
    const viaPath = createDependencies();

    await request(createMcpDoorApp(viaMcp)).post("/session").send({ publicId: PUBLIC_ID }).expect(201);
    await request(createPathDoorApp(viaPath)).post(`/doors/${PUBLIC_ID}`).send({}).expect(200);

    // One budget across both doors: identical scopes and subject keys, so a caller cannot
    // double its walk-in allowance by alternating between them.
    expect(spentBudgets(viaPath)).toEqual(spentBudgets(viaMcp));
    expect(spentBudgets(viaPath).map((policy) => policy.scope)).toEqual([
      "mcp.converse.walkin.source",
      "mcp.converse.walkin.agent.source",
      "mcp.converse.walkin.agent",
    ]);
    expect(spentBudgets(viaPath)[1]).toMatchObject({ limit: 5 });
  });

  it("publishes the source digest for the door that runs next", async () => {
    const response = await request(createPathDoorApp(createDependencies())).post(`/doors/${PUBLIC_ID}`).send({}).expect(200);

    expect(response.body.sourceDigest).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
  });

  it("spends nothing when the door says the request opens no walk-in conversation", async () => {
    const dependencies = createDependencies();

    await request(createPathDoorApp(dependencies)).post(`/doors/${PUBLIC_ID}`).send({ contextId: "sealed" }).expect(200);

    expect(dependencies.abuseControlService.enforce).not.toHaveBeenCalled();
    expect(dependencies.agentRepository.findByPublicId).not.toHaveBeenCalled();
  });

  it("names the door in the throttle audit event and counts the throttle", async () => {
    const dependencies = createDependencies(vi.fn().mockImplementation(async (policy: { scope: string }) => {
      if (policy.scope === "mcp.converse.walkin.agent.source") {
        throw Object.assign(new Error("Too many requests"), { statusCode: 429, code: "rate_limit_exceeded" });
      }
      return admittedAbuseControlDecision();
    }));
    const observer = { record: vi.fn() };

    await request(createPathDoorApp(dependencies, observer)).post(`/doors/${PUBLIC_ID}`).send({}).expect(429);

    expect(dependencies.auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security.rate_limit_enforced",
      workspaceId: "workspace-1",
      metadata: expect.objectContaining({
        scope: "mcp.converse.walkin.agent.source",
        surface: "a2a_walk_in",
        agentId: "agent-1",
      }),
    }));
    expect(JSON.stringify(dependencies.auditService.record.mock.calls)).not.toContain(PUBLIC_ID);
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: "throttled", agentId: "agent-1" }));
  });
});
