import { Writable } from "node:stream";
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

describe("HTTP logger redaction", () => {
  it("redacts credential headers while preserving request fields", async () => {
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
      .get("/health?visible=yes")
      .set("cookie", "session=secret-request-cookie")
      .set("authorization", "Bearer radioso_secret")
      .set("x-radioso-worker-token", "worker-task-secret")
      .set("x-radioso-public-session", "public-session-secret")
      .set("x-workspace-id", "workspace-secret")
      .set("x-visible-header", "visible-value")
      .expect(200);

    const logLines = lines.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const requestLog = logLines.find((line) => line.msg === "request completed");

    expect(requestLog).toBeDefined();
    expect(JSON.stringify(requestLog)).not.toContain("secret-request-cookie");
    expect(JSON.stringify(requestLog)).not.toContain("radioso_secret");
    expect(JSON.stringify(requestLog)).not.toContain("worker-task-secret");
    expect(JSON.stringify(requestLog)).not.toContain("public-session-secret");
    expect(JSON.stringify(requestLog)).not.toContain("workspace-secret");
    expect(JSON.stringify(requestLog)).not.toContain("secret-response-cookie");
    expect(JSON.stringify(requestLog)).not.toContain("anonymous-session-secret");
    expect(JSON.stringify(requestLog)).not.toContain("public-session-id-secret");
    expect(JSON.stringify(requestLog)).toContain("[REDACTED]");
    expect(requestLog).toMatchObject({
      requestId: "req-redaction-test",
      req: {
        method: "GET",
        url: "/health?visible=yes",
        headers: {
          "x-visible-header": "visible-value",
        },
      },
      res: {
        statusCode: 200,
      },
    });
  });
});
