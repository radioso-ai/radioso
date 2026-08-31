import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createCopilotRoutes } from "../../../src/modules/operatorCopilot/routes.js";
import { CopilotConflictError } from "../../../src/modules/operatorCopilot/public.js";

const ACCOUNT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";
const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "44444444-4444-4444-4444-444444444444";

describe("createCopilotRoutes", () => {
  it("mounts the fixed copilot endpoint set", () => {
    const router = createCopilotRoutes({
      env: { SESSION_COOKIE_NAME: "session" },
      authService: {},
      workspaceSessionService: {},
      accountAccessService: {},
      llmCapabilityResolver: {},
      operatorCopilotService: {},
      copilotToolCatalog: [],
    } as never);

    const paths = router.stack
      .flatMap((layer: { route?: { path?: string } }) => layer.route?.path ? [layer.route.path] : []);
    expect(paths).toEqual(expect.arrayContaining(["/availability", "/conversations", "/turns"]));
  });

  it("reports agent management permission in availability", async () => {
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
    app.use("/api/v1/copilot", createCopilotRoutes({
      env: { SESSION_COOKIE_NAME: "radioso_session" },
      authService: {
        async authenticateSession() { return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" }; },
      },
      workspaceSessionService: {
        async resolve() { return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID }; },
      },
      accountAccessService: {
        async requireActiveMembership() {},
        async requirePermission() {},
        hasPermission: vi.fn(async ({ permission }: { permission: string }) => permission !== "workspace.agents.manage"),
      },
      llmCapabilityResolver: {
        async resolve() { return {}; },
      },
      operatorCopilotService: {},
      copilotToolCatalog: [],
    } as never));

    const response = await request(app)
      .get("/api/v1/copilot/availability")
      .set("Cookie", "radioso_session=valid-session");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ available: true, reason: "ok", canManage: false });
  });

  it("returns a JSON conflict before committing SSE headers when a turn cannot be acquired", async () => {
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
    app.use("/api/v1/copilot", createCopilotRoutes({
      env: { SESSION_COOKIE_NAME: "radioso_session" },
      authService: {
        async authenticateSession() { return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" }; },
      },
      workspaceSessionService: {
        async resolve() { return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID }; },
      },
      accountAccessService: {
        async requireActiveMembership() {},
        async requirePermission() {},
        hasPermission: vi.fn(async () => true),
      },
      llmCapabilityResolver: {
        async resolve() { return {}; },
      },
      operatorCopilotService: {
        runTurn: async function* () { throw new CopilotConflictError(); },
      },
      copilotToolCatalog: [],
    } as never));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const appError = error as { statusCode?: number; code?: string };
      res.status(appError.statusCode ?? 500).json({ error: { code: appError.code ?? "internal_error" } });
    });

    const response = await request(app)
      .post("/api/v1/copilot/turns")
      .set("Cookie", "radioso_session=valid-session")
      .send({
        conversationId: CONVERSATION_ID,
        message: "Try this follow-up",
        pageContext: { view: "history", agentId: null, conversationId: null, selection: null, entities: [] },
      });

    expect(response.status).toBe(409);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({ code: "conflict" });
  });
  it("resolves the permissions a contributed tool declares, not only the module's own baseline", async () => {
    // A permission the turn route never resolves filters its tool out of every live turn while
    // unit tests that inject permissions directly still pass. An application module contributing a
    // tool cannot edit this module's baseline list, so the per-turn set is derived from the catalog.
    const hasPermission = vi.fn(async (_input: { permission: string }) => true);
    const runTurn = vi.fn((_input: { permissions: Set<string> }) => (async function* () { throw new CopilotConflictError(); })());
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
    app.use("/api/v1/copilot", createCopilotRoutes({
      env: { SESSION_COOKIE_NAME: "radioso_session" },
      authService: {
        async authenticateSession() { return { accountId: ACCOUNT_ID, userId: USER_ID, sessionId: "session-id" }; },
      },
      workspaceSessionService: {
        async resolve() { return { accountId: ACCOUNT_ID, workspaceId: WORKSPACE_ID }; },
      },
      accountAccessService: {
        async requireActiveMembership() {},
        async requirePermission() {},
        hasPermission,
      },
      llmCapabilityResolver: { async resolve() { return {}; } },
      operatorCopilotService: { runTurn },
      copilotToolCatalog: [{ requiredPermissions: ["workspace.token.read"] }],
    } as never));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const appError = error as { statusCode?: number; code?: string };
      res.status(appError.statusCode ?? 500).json({ error: { code: appError.code ?? "internal_error" } });
    });

    await request(app)
      .post("/api/v1/copilot/turns")
      .set("Cookie", "radioso_session=valid-session")
      .send({
        conversationId: CONVERSATION_ID,
        message: "What are my limits?",
        pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
      });

    expect(hasPermission.mock.calls.map(([input]) => input.permission)).toContain("workspace.token.read");
    expect([...runTurn.mock.calls[0]![0].permissions]).toContain("workspace.token.read");
  });
});
