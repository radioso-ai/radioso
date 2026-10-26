import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import { createLogger } from "../../src/shared/observability/logger.js";
import { createMatchedRouteRecorder } from "../../src/shared/observability/matchedRoute.js";
import type { ErrorSink } from "../../src/shared/errors/errorSink.js";

const captureErrorLog = (sinks: ErrorSink[] = []): { service: ErrorReportingService; line: () => Record<string, unknown>; raw: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    service: new ErrorReportingService({
      environment: "test",
      // The production logger, so its serializers run on the line exactly as they do in Cloud Logging.
      logger: createLogger("info", stream),
      service: "radioso-api",
      sinks,
    }),
    line: () => JSON.parse(chunks.find((chunk) => chunk.includes("error_recorded")) ?? "{}") as Record<string, unknown>,
    raw: () => chunks.join(""),
  };
};

const visitorWords = "my daughter has asthma and needs the ground floor room";

const stackLines = (line: Record<string, unknown>): string[] => (typeof line.stack === "string" ? line.stack.split("\n") : []);

describe("error_recorded log line", () => {
  it("keeps an error's type, class and stack frames but never its message", async () => {
    const { service, line, raw } = captureErrorLog();

    await service.report({
      errorType: "chat.turn.failed",
      error: new TypeError(`Could not parse the slot value "${visitorWords}"`),
    });

    expect(raw()).not.toContain(visitorWords);
    expect(line().errorEvent).toMatchObject({ errorType: "chat.turn.failed", severity: "error", errorClass: "TypeError" });
    expect(stackLines(line())[0]).toContain("error-recorded-log-line.test.ts");
    expect(stackLines(line()).every((frame) => frame.trimStart().startsWith("at "))).toBe(true);
  });

  it("keeps the frames of private methods, accessors, symbols and non-ASCII names", async () => {
    const { service, line } = captureErrorLog();
    const frames = [
      "    at #transformResult (file:///app/node_modules/kysely/dist/esm/query-executor.js:12:5)",
      "    at get value (/app/dist/modules/chat/slot.js:4:9)",
      "    at Array.[Symbol.iterator] (<anonymous>)",
      "    at prüfeEingabe (/app/dist/modules/routines/validate.js:7:3)",
      "    at async Promise.all (index 0)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      "    at C:\\app\\dist\\index.js:1:2",
      "    at Socket.emit (node:events:519:28)",
      "    at <anonymous>",
      "async*render@/_next/static/chunks/app.js:3:4",
    ];

    await service.report({ errorType: "chat.turn.failed", stack: ["Error: failed", ...frames].join("\n") });

    expect(stackLines(line())).toEqual(frames);
  });

  it("drops message lines that only resemble a frame", async () => {
    const { service, line } = captureErrorLog();

    await service.report({
      errorType: "chat.turn.failed",
      stack: [
        "Error: booking failed",
        "    at 10:30:00",
        "    at home (see:1:2)",
        `    at ${"a/".repeat(20_000)}:1:2`,
        "    at https://example.com/search?q=my%20daughter%20asthma:1:2",
        "    at load (file:///app/page.js#my%20daughter:1:2)",
        "    at handler (/app/dist/index.js:1:2)",
      ].join("\n"),
    });

    expect(stackLines(line())).toEqual(["    at handler (/app/dist/index.js:1:2)"]);
  });

  it("drops each line of a multi-line message, even one indented like a frame", async () => {
    const { service, raw } = captureErrorLog();
    const error = new Error(`Visitor wrote:\n    at home ${visitorWords}\n${visitorWords}`);

    await service.report({ errorType: "chat.turn.failed", error });

    expect(raw()).not.toContain(visitorWords);
    expect(raw()).not.toContain("Visitor wrote");
  });

  it("keeps a browser report's frames and drops its message and free text", async () => {
    const { service, line, raw } = captureErrorLog();

    await service.report({
      errorType: "frontend.react.unhandled",
      errorClass: "TypeError",
      message: visitorWords,
      stack: [
        `TypeError: ${visitorWords}`,
        "    at Dashboard (/w/[workspaceKey]/chat:1:2)",
        "renderRoot@/_next/static/chunks/app.js:3:4",
      ].join("\n"),
      requestContext: { method: "CLIENT", route: "/w/[workspaceKey]/chat" },
      metadata: {
        componentStack: `\n    at Composer (/_next/static/chunks/app.js:5:6)\n    at Inbox (${visitorWords})`,
        source: "embed",
        userAgent: "Mozilla/5.0 (Macintosh)",
      },
    });

    expect(raw()).not.toContain(visitorWords);
    expect(raw()).not.toContain("Mozilla");
    expect(stackLines(line())).toEqual([
      "    at Dashboard (/w/[workspaceKey]/chat:1:2)",
      "renderRoot@/_next/static/chunks/app.js:3:4",
    ]);
    expect(line().metadata).toEqual({ source: "embed", componentStack: "    at Composer (/_next/static/chunks/app.js:5:6)" });
  });

  it("keeps the ids, counts, flags and codes a log query correlates on, and drops the rest", async () => {
    const { service, line, raw } = captureErrorLog();
    const messageId = randomUUID();

    await service.report({
      errorType: "hitl.ownership.notification_failed",
      error: new Error("push failed"),
      metadata: {
        notification: "visitor_push",
        messageId,
        attempt: 2,
        retried: true,
        action: visitorWords,
        reason: visitorWords,
        detail: { excerpt: visitorWords },
        suggestions: [visitorWords],
      },
    });

    expect(raw()).not.toContain(visitorWords);
    expect(line().metadata).toEqual({ notification: "visitor_push", messageId, attempt: 2, retried: true });
  });

  it("keeps a dead-lettered job's kind and error summary", async () => {
    const { service, line } = captureErrorLog();
    const jobId = randomUUID();

    await service.report({
      errorType: "background_job.dead_lettered",
      metadata: { kind: "document.process", attempt: 5, jobId, lastError: "AppError [document_not_found]", hookError: "AppError [conflict]" },
    });
    await service.report({
      errorType: "background_job.poll_failed",
      metadata: { errorClass: `TypeError: ${visitorWords}`, lastError: visitorWords, kind: visitorWords },
    });

    expect(line().metadata).toEqual({
      kind: "document.process",
      attempt: 5,
      jobId,
      lastError: "AppError [document_not_found]",
      hookError: "AppError [conflict]",
    });
  });

  it("drops correlation values that are not ids", async () => {
    const { service, line, raw } = captureErrorLog();
    const conversationId = randomUUID();

    await service.report({
      errorType: "http.request.unhandled",
      error: new Error("boom"),
      correlation: { requestId: "17", workspaceId: visitorWords, conversationId, accountId: "not an id", method: "GET", route: "/api/v1/history" },
    });

    expect(raw()).not.toContain(visitorWords);
    expect(raw()).not.toContain("not an id");
    expect(line().errorEvent).toMatchObject({ requestId: "17", conversationId, method: "GET", route: "/api/v1/history" });
  });

  it("drops a route that only survived a query-string strip, not a real path shape", async () => {
    const { service, line, raw } = captureErrorLog();
    const emailAddress = "visitor@example.com";

    await service.report({
      errorType: "frontend.runtime.unhandled",
      error: new Error("boom"),
      requestContext: { method: "CLIENT", route: `visitor typed this: contact me at ${emailAddress}` },
    });

    expect(raw()).not.toContain(emailAddress);
    expect(raw()).not.toContain("visitor typed this");
    expect(line().errorEvent).toMatchObject({ method: "CLIENT" });
    expect(line().errorEvent).not.toHaveProperty("route");
  });

  it("drops a percent-encoded route, which can spell out a sentence", async () => {
    const { service, line, raw } = captureErrorLog();

    await service.report({
      errorType: "frontend.runtime.unhandled",
      error: new Error("boom"),
      requestContext: { method: "CLIENT", route: "/my%20daughter%20has%20asthma" },
    });

    expect(raw()).not.toContain("daughter");
    expect(line().errorEvent).not.toHaveProperty("route");
  });

  it("names an unhandled request error's route by its pattern, never the token resolved into it", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const { service, line, raw } = captureErrorLog([sink]);
    const app = express();
    app.use(createMatchedRouteRecorder());
    const router = express.Router();
    router.post("/invitations/:token/accept", (_req, _res, next) => {
      next(new Error(`Could not accept the invitation for ${visitorWords}`));
    });
    app.use("/api/v1/auth", router);
    app.use(createErrorHandler(service));

    await request(app).post("/api/v1/auth/invitations/super-secret-invite-token/accept?ref=newsletter").expect(500);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(raw()).not.toContain("super-secret-invite-token");
    expect(raw()).not.toContain(visitorWords);
    expect(line().errorEvent).toMatchObject({ method: "POST", route: "/api/v1/auth/invitations/:token/accept" });
    const reported = vi.mocked(sink.record).mock.calls[0]?.[0];
    expect(JSON.stringify(reported)).not.toContain("super-secret-invite-token");
    expect(reported).toMatchObject({
      message: `Could not accept the invitation for ${visitorWords}`,
      requestContext: { route: "/api/v1/auth/invitations/:token/accept" },
      correlation: { route: "/api/v1/auth/invitations/:token/accept" },
    });
  });

  it("names no route for an unhandled error raised before any route matched", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const { service, raw } = captureErrorLog([sink]);
    const app = express();
    app.use(createMatchedRouteRecorder());
    app.use("/api/v1/public/chat", (_req, _res, next) => {
      next(new Error("session lookup failed"));
    });
    app.use(createErrorHandler(service));

    await request(app).get("/api/v1/public/chat/super-secret-chat-token/messages").expect(500);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(raw()).not.toContain("super-secret-chat-token");
    const reported = vi.mocked(sink.record).mock.calls[0]?.[0];
    expect(JSON.stringify(reported)).not.toContain("super-secret-chat-token");
    expect(reported?.requestContext).not.toHaveProperty("route");
  });

  it("logs nothing of a thrown non-error value", async () => {
    const { service, line, raw } = captureErrorLog();

    await service.report({ errorType: "process.unhandledRejection", error: { prompt: visitorWords } });
    await service.report({ errorType: "process.unhandledRejection", error: `rejected: ${visitorWords}` });

    expect(raw()).not.toContain(visitorWords);
    expect(line().errorEvent).toMatchObject({ errorType: "process.unhandledRejection", errorClass: "NonErrorThrowable" });
  });

  it("still hands the full error to its sinks", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const { service } = captureErrorLog([sink]);

    await service.report({
      errorType: "chat.turn.failed",
      error: new Error(`Could not parse "${visitorWords}"`),
      metadata: { reason: visitorWords },
    });

    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      message: `Could not parse "${visitorWords}"`,
      stack: expect.stringContaining(visitorWords),
      metadata: { reason: visitorWords },
    }));
  });
});
