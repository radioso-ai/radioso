import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createA2aObserver, createA2aRoutes, type A2aService } from "../../../src/modules/a2a/public.js";
import { AppError } from "../../../src/shared/domain/errors.js";
import type { AgentConversePrincipal } from "../../../src/modules/settings/contracts/agentConverseSession.js";

const pass: RequestHandler = (_req, _res, next) => next();

const appWith = (service: Pick<A2aService, "admit" | "handle">, metrics = { incrementCounter: vi.fn() }) => {
  const app = express();
  app.use(express.json());
  app.use("/a2a/:publicId", createA2aRoutes({
    service: service as A2aService,
    directory: { resolve: async () => ({ agentId: "a-1", workspaceId: "w-1" }) },
    observer: createA2aObserver({ metrics }),
    maxMessageLength: 4_000,
    middleware: {
      turnSourceLimit: pass,
      readSourceLimit: pass,
      walkInLimit: pass,
      turnLimits: [pass],
      readLimits: [pass],
      admitPrincipal: () => undefined,
      sourceDigest: () => null,
      bearer: () => null,
    },
  }));
  app.use(((error, _req, res, _next) => {
    res.status((error as AppError).statusCode ?? 500).json({ error: { code: (error as AppError).code } });
  }) as express.ErrorRequestHandler);
  return { app, metrics };
};

const admitted = {
  admit: vi.fn(async () => ({
    kind: "context" as const,
    principal: {} as AgentConversePrincipal,
    opening: { workspaceId: "w-1", agentId: "a-1", publicSessionId: "s", origin: { kind: "walk_in" as const, publicId: "ag_x" }, expiresAt: null },
    contextToken: "ctx",
    conversationId: "c",
    task: null,
  })),
};

const send = (app: express.Express) => request(app)
  .post("/a2a/ag_x")
  .set("A2A-Version", "1.0")
  .send({ jsonrpc: "2.0", id: 9, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "Hi" }] } } });

describe("A2A routes: turn failures a caller can act on", () => {
  it("answers a turn a newer message on the same context superseded with reason TURN_SUPERSEDED", async () => {
    const { app } = appWith({
      ...admitted,
      handle: async () => {
        throw new AppError(409, "chat_turn_superseded", "Chat turn was superseded by a newer message.", { conversationId: "c" });
      },
    });

    const response = await send(app).expect(200);

    expect(response.body).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: {
        code: -32000,
        message: expect.any(String),
        data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TURN_SUPERSEDED", domain: "radioso.ai", metadata: {} }],
      },
    });
  });

  it("answers a workspace over its quota with a structured reason, and hands any other fault to the error handler", async () => {
    const overQuota = appWith({ ...admitted, handle: async () => { throw new AppError(429, "usage_limit_exceeded", "Over quota", { plan: "free" }); } });
    const broken = appWith({ ...admitted, handle: async () => { throw new Error("database down"); } });

    const quota = await send(overQuota.app).expect(200);
    const fault = await send(broken.app).expect(500);

    expect(quota.body.error.data).toEqual([expect.objectContaining({ reason: "USAGE_LIMIT_EXCEEDED", domain: "radioso.ai" })]);
    expect(JSON.stringify(quota.body)).not.toContain("free");
    expect(fault.body).toEqual({ error: { code: undefined } });
  });

  it("counts a 4xx the shared error handler answered as a client error, never as ok", async () => {
    const { app, metrics } = appWith({ ...admitted, handle: async () => { throw new AppError(409, "conflict", "Conflict"); } });

    await send(app).expect(409);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("a2a_requests_total", expect.objectContaining({ labels: { method: "SendMessage", outcome: "client_error" } }));
  });

  it("takes A2A-Version from the query parameter when no header is sent, and lets the header win over it", async () => {
    const { app } = appWith({ ...admitted, handle: async () => ({ message: { messageId: "r" } }) });
    const body = { jsonrpc: "2.0", id: 4, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "Hi" }] } } };

    const fromQuery = await request(app).post("/a2a/ag_x?A2A-Version=1.0").send(body).expect(200);
    const headerWins = await request(app).post("/a2a/ag_x?A2A-Version=1.0").set("A2A-Version", "0.3").send(body).expect(200);

    expect(fromQuery.body.result).toEqual({ message: { messageId: "r" } });
    expect(headerWins.body.error).toMatchObject({ code: -32009, data: [{ reason: "VERSION_NOT_SUPPORTED" }] });
  });

  it("counts each request by method and outcome, with no agent, context or task label", async () => {
    const { app, metrics } = appWith({ ...admitted, handle: async () => ({ message: { messageId: "r" } }) });

    await send(app).expect(200);
    await request(app).post("/a2a/ag_x").set("A2A-Version", "1.0").send({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} }).expect(200);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("a2a_requests_total", expect.objectContaining({ labels: { method: "SendMessage", outcome: "ok" } }));
    expect(metrics.incrementCounter).toHaveBeenCalledWith("a2a_requests_total", expect.objectContaining({ labels: { method: "other", outcome: "METHOD_NOT_FOUND" } }));
  });
});
