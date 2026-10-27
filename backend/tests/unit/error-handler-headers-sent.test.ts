import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { ChatTurnDisconnectAbortError } from "../../src/modules/chat/services/conversationTurnRegistry.js";
import { ProviderConfigurationError } from "../../src/shared/infra/llm/providerTypes.js";
import { normalizeProviderCredentialError } from "../../src/shared/infra/llm/providerErrors.js";
import { ErrorReportingService } from "../../src/shared/errors/errorReportingService.js";
import type { ErrorSink } from "../../src/shared/errors/errorSink.js";

const createLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() });

const buildService = (sink: ErrorSink) =>
  new ErrorReportingService({
    enabled: true,
    environment: "test",
    logger: createLogger() as any,
    service: "radioso-api",
    sinks: [sink],
  });

const fakeReq = (): Request => ({ method: "GET", originalUrl: "/stream", path: "/stream", header: () => undefined } as unknown as Request);

/** A response that already flushed headers (the SSE case: `res.headersSent` is true). */
const fakeSentRes = (): Response => {
  let ended = false;
  return {
    headersSent: true,
    statusCode: 200,
    destroyed: false,
    get writableEnded() {
      return ended;
    },
    end: vi.fn(() => {
      ended = true;
    }),
  } as unknown as Response;
};

describe("createErrorHandler — headers already sent (SSE mid-stream failure)", () => {
  it("reports an unreported fault once instead of handing it to Express's finalhandler", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    const error = Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" });

    handler(error, fakeReq(), res, next);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("does not report the same error object twice when a caller already reported it", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const error = Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" });
    // Simulates ChatTurnLifecycle.recordFailure already reporting this exact error
    // before it propagated up to the HTTP layer.
    await service.report({ errorType: "chat.turn_failed", error });
    expect(sink.record).toHaveBeenCalledOnce();

    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();

    handler(error, fakeReq(), res, next);
    // Give any fire-and-forget reporting a chance to run before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("never reports a client-facing AppError under 500 (an already-handled, expected outcome)", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    const error = new AppError(429, "usage_limit_exceeded", "Monthly message limit reached");

    handler(error, fakeReq(), res, next);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("never reports a disconnect-abort turn despite its 500 status (an expected client-driven outcome)", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    const error = new ChatTurnDisconnectAbortError("conv_1", "rendering");

    handler(error, fakeReq(), res, next);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("reports a platform misconfiguration (ProviderConfigurationError, AppError 503) — a platform fault, not a client outcome", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    const error = new ProviderConfigurationError('No API key configured for provider "openai".', { kind: "missing_api_key" });

    handler(error, fakeReq(), res, next);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("reports a normalized provider-credential rejection (AppError 503) — the same incident class as an undeployed model", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    const error = normalizeProviderCredentialError({ status: 401, code: "invalid_api_key" });

    handler(error, fakeReq(), res, next);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(next).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("ends the response exactly once even if it was already ended", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    res.end();
    (res.end as ReturnType<typeof vi.fn>).mockClear();

    handler(new Error("boom"), fakeReq(), res, next);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(res.end).not.toHaveBeenCalled();
  });

  it("over real HTTP: an SSE stream that fails after flushing headers reports once and closes cleanly", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const app = express();
    app.get("/stream", (_req, res, next) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: status\n\n");
      next(Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" }));
    });
    app.use(createErrorHandler(service));

    const response = await request(app).get("/stream");

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ errorType: "http.request.unhandled" }));
  });
});
