import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
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
      logger: pino({ level: "info" }, stream),
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
    expect(line().error).toMatchObject({ errorType: "chat.turn.failed", severity: "error", errorClass: "TypeError" });
    expect(stackLines(line()).length).toBeGreaterThan(0);
    expect(stackLines(line()).every((frame) => frame.trimStart().startsWith("at "))).toBe(true);
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
      metadata: { componentStack: `\n    at Composer (${visitorWords})`, source: "embed", userAgent: "Mozilla/5.0 (Macintosh)" },
    });

    expect(raw()).not.toContain(visitorWords);
    expect(raw()).not.toContain("Mozilla");
    expect(stackLines(line())).toEqual([
      "    at Dashboard (/w/[workspaceKey]/chat:1:2)",
      "renderRoot@/_next/static/chunks/app.js:3:4",
    ]);
    expect(line().metadata).toEqual({ source: "embed" });
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

  it("logs nothing of a thrown non-error value", async () => {
    const { service, line, raw } = captureErrorLog();

    await service.report({ errorType: "process.unhandledRejection", error: { prompt: visitorWords } });
    await service.report({ errorType: "process.unhandledRejection", error: `rejected: ${visitorWords}` });

    expect(raw()).not.toContain(visitorWords);
    expect(line().error).toMatchObject({ errorType: "process.unhandledRejection", errorClass: "NonErrorThrowable" });
  });

  it("still hands the full error to its sinks", async () => {
    const sink: ErrorSink = { record: vi.fn().mockResolvedValue(undefined) };
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
