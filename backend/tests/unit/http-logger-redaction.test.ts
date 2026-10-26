import { Writable } from "node:stream";
import { EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createHttpLogger, createLogger, type AppLogger } from "../../src/shared/observability/logger.js";
import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";

const createCapturedLogger = (): { logger: AppLogger; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return {
    logger: createLogger("info", stream),
    lines,
  };
};

const visitorWords = "my daughter has asthma and needs the ground floor room";

const lastLine = (lines: string[]): Record<string, unknown> =>
  JSON.parse(lines.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;

describe("HTTP request log line", () => {
  it("logs a request as its method, path and status alone", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();

    app.use((req, _res, next) => {
      (req as { id?: string }).id = "req-redaction-test";
      next();
    });
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    app.get("/health", (_req, res) => {
      res.setHeader("set-cookie", "session=secret-response-cookie");
      res.setHeader("x-radioso-anonymous-session", "anonymous-session-secret");
      res.setHeader("x-radioso-public-session-id", "public-session-id-secret");
      res.status(200).json({ ok: true });
    });

    await request(app)
      .get(`/health?q=${encodeURIComponent(visitorWords)}#top`)
      .set("cookie", "session=secret-request-cookie")
      .set("authorization", "Bearer radioso_secret")
      .set("x-radioso-worker-token", "worker-task-secret")
      .set("x-radioso-public-session", "public-session-secret")
      .set("x-workspace-id", "workspace-secret")
      .set("x-forwarded-for", "203.0.113.9, 10.0.0.4")
      .set("referer", `https://app.radioso.ai/dashboard?search=${encodeURIComponent(visitorWords)}`)
      .set(EDGE_FACTS_HEADERS.facts, "edge-facts-forwarded-chain")
      .set(EDGE_FACTS_HEADERS.signature, "edge-facts-signature")
      .expect(200);

    const raw = lines.join("");
    const logLines = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const requestLog = logLines.find((line) => line.msg === "request completed");

    for (const text of [
      visitorWords,
      encodeURIComponent(visitorWords),
      "secret-request-cookie",
      "radioso_secret",
      "worker-task-secret",
      "public-session-secret",
      "workspace-secret",
      "203.0.113.9",
      "edge-facts-forwarded-chain",
      "edge-facts-signature",
      "secret-response-cookie",
      "anonymous-session-secret",
      "public-session-id-secret",
    ]) {
      expect(raw).not.toContain(text);
    }
    expect(requestLog).toMatchObject({ requestId: "req-redaction-test", route: "/health" });
    expect(requestLog?.req).toEqual({ id: "req-redaction-test", method: "GET" });
    expect(requestLog?.res).toEqual({ statusCode: 200 });
  });

  it("carries the request's trace id so a line joins Cloud Run's request log", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createHttpLogger(logger));
    app.get("/health", (_req, res) => {
      res.status(200).end();
    });

    await request(app).get("/health").set("x-cloud-trace-context", "105445aa7843bc8bf206b12000100000/1;o=1").expect(200);
    await request(app).get("/health").set("x-cloud-trace-context", `${visitorWords}/1;o=1`).expect(200);

    const requestLogs = lines.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requestLogs[0]?.req).toMatchObject({ traceId: "105445aa7843bc8bf206b12000100000" });
    expect(requestLogs[1]?.req).not.toHaveProperty("traceId");
    expect(lines.join("")).not.toContain(visitorWords);
  });

  it("names a failed request's error by its class alone", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createHttpLogger(logger));
    app.get("/boom", (_req, res) => {
      (res as { err?: Error }).err = new TypeError(`Could not book "${visitorWords}"`);
      res.status(500).end();
    });

    await request(app).get("/boom").expect(500);

    const requestLog = JSON.parse(lines.join("").trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(lines.join("")).not.toContain(visitorWords);
    expect(requestLog.err).toEqual({ type: "TypeError" });
  });

  it("logs the matched route pattern, not a credential segment resolved into it", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    const router = express.Router();
    router.get("/invitations/:token", (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.use("/api/v1/auth", router);

    await request(app).get("/api/v1/auth/invitations/super-secret-invite-token").expect(200);

    expect(lines.join("")).not.toContain("super-secret-invite-token");
    expect(lastLine(lines)).toMatchObject({ route: "/api/v1/auth/invitations/:token" });
  });

  it("keeps the whole pattern when a route's error leaves its router through next(err)", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    const router = express.Router();
    router.post("/invitations/:token/accept", (_req, _res, next) => {
      next(new Error("invitation lookup failed"));
    });
    app.use("/api/v1/auth", router);
    app.use(((_error, _req, res, _next) => {
      res.status(500).json({ error: "internal_error" });
    }) as express.ErrorRequestHandler);

    await request(app).post("/api/v1/auth/invitations/super-secret-invite-token/accept").expect(500);

    expect(lines.join("")).not.toContain("super-secret-invite-token");
    expect(lastLine(lines)).toMatchObject({ route: "/api/v1/auth/invitations/:token/accept", res: { statusCode: 500 } });
  });

  it("names a parameter mount by its parameter, not the value it resolved to", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    const connectors = express.Router();
    const webhook = express.Router({ mergeParams: true });
    webhook.post("/", (_req, res) => {
      res.status(202).end();
    });
    connectors.use("/wordpress/:workspaceId/webhook", webhook);
    app.use("/api/connectors", connectors);

    await request(app).post("/api/connectors/wordpress/8509864081/webhook").expect(202);

    expect(lines.join("")).not.toContain("8509864081");
    expect(lastLine(lines)).toMatchObject({ route: "/api/connectors/wordpress/:workspaceId/webhook/" });
  });

  it("logs no route for a response a middleware sent before any route matched", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    const publicChat = express.Router();
    publicChat.use((_req, res) => {
      res.status(429).json({ error: "rate_limited" });
    });
    publicChat.get("/:token/messages", (_req, res) => {
      res.status(200).end();
    });
    const auth = express.Router();
    auth.use((_req, res) => {
      res.status(401).json({ error: "unauthorized" });
    });
    auth.get("/invitations/:token", (_req, res) => {
      res.status(200).end();
    });
    app.use("/api/v1/public/chat", publicChat);
    app.use("/api/v1/auth", auth);

    await request(app).get("/api/v1/public/chat/super-secret-chat-token/messages").expect(429);
    await request(app).get("/api/v1/auth/invitations/super-secret-invite-token").expect(401);

    const requestLogs = lines.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.join("")).not.toContain("super-secret-chat-token");
    expect(lines.join("")).not.toContain("super-secret-invite-token");
    expect(requestLogs.map((line) => line.res)).toEqual([{ statusCode: 429 }, { statusCode: 401 }]);
    for (const line of requestLogs) {
      expect(line).not.toHaveProperty("route");
    }
  });

  it("does not fall back to the raw path for an unmatched route", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use(createHttpLogger(logger));
    // No routes registered; Express answers 404 on its own, leaving req.route unset.

    await request(app).get("/api/v1/public/chat/super-secret-chat-token/messages").expect(404);

    expect(lines.join("")).not.toContain("super-secret-chat-token");
    expect(lastLine(lines)).not.toHaveProperty("route");
  });
});
