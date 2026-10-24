import { Writable } from "node:stream";
import { EDGE_FACTS_HEADERS } from "@radioso/edge-proof";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createHttpLogger, type AppLogger } from "../../src/shared/observability/logger.js";

const createCapturedLogger = (): { logger: AppLogger; lines: string[] } => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return {
    logger: pino({ level: "info" }, stream),
    lines,
  };
};

const visitorWords = "my daughter has asthma and needs the ground floor room";

describe("HTTP request log line", () => {
  it("logs a request as its method, path and status alone", async () => {
    const { logger, lines } = createCapturedLogger();
    const app = express();

    app.use((req, _res, next) => {
      (req as { id?: string }).id = "req-redaction-test";
      next();
    });
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
    expect(requestLog).toMatchObject({ requestId: "req-redaction-test" });
    expect(requestLog?.req).toEqual({ id: "req-redaction-test", method: "GET", url: "/health" });
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
});
