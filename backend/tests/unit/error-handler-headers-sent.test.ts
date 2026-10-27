import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createErrorHandler } from "../../src/app/http/middleware/errorHandler.js";
import { AppError, serviceUnavailable } from "../../src/shared/domain/errors.js";
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
  let destroyedFlag = false;
  return {
    headersSent: true,
    statusCode: 200,
    get destroyed() {
      return destroyedFlag;
    },
    get writableEnded() {
      return ended;
    },
    end: vi.fn(() => {
      ended = true;
    }),
    destroy: vi.fn(() => {
      destroyedFlag = true;
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
    expect(res.destroy).toHaveBeenCalledOnce();
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
    expect(res.destroy).toHaveBeenCalledOnce();
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
    expect(res.destroy).toHaveBeenCalledOnce();
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
    expect(res.destroy).toHaveBeenCalledOnce();
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
    expect(res.destroy).toHaveBeenCalledOnce();
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
    expect(res.destroy).toHaveBeenCalledOnce();
  });

  it("closes the response exactly once — never again once it already ended on its own", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeSentRes();
    // Simulates sendChatSse's own `finally` already ending the SSE stream before the
    // error ever reaches this middleware — the common case in production.
    res.end();
    (res.end as ReturnType<typeof vi.fn>).mockClear();

    handler(new Error("boom"), fakeReq(), res, next);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it("over real HTTP: an SSE stream that already ended itself (sendChatSse's finally) reports once and the client sees a clean 200", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const app = express();
    app.get("/stream", (_req, res, next) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: status\n\n");
      // Mirrors sendChatSse's own `finally`: the SSE response is already ended by the
      // time the error reaches this middleware, so closeOpenResponse is a no-op here.
      res.end();
      next(Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" }));
    });
    app.use(createErrorHandler(service));

    const response = await request(app).get("/stream");

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ errorType: "http.request.unhandled" }));
  });

  it("over real HTTP: a non-SSE response that fails mid-body (not yet ended) reports once and resets the connection instead of a silently truncated body", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const app = express();
    app.get("/stream", (_req, res, next) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"partial":');
      // Never ends its own response — the error reaches this middleware mid-body.
      next(Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" }));
    });
    app.use(createErrorHandler(service));

    // A destroyed connection looks like a socket error to the client, not a
    // successful (if truncated) response — the honest outcome for a body that never
    // finished, same as what Express's own finalhandler would do here.
    await expect(request(app).get("/stream")).rejects.toThrow();
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());
    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({ errorType: "http.request.unhandled" }));
  });
});

/** A response that never sent headers — the normal (non-streaming) JSON error path. */
const fakeUnsentRes = (): Response => {
  const res: any = {
    headersSent: false,
    destroyed: false,
    writableEnded: false,
  };
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res as Response;
};

describe("createErrorHandler — headers not sent (the unhandled-error fallback branch)", () => {
  it("does not report the same error twice when ChatTurnLifecycle.recordFailure already reported it (a stream:false chat turn)", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const error = Object.assign(new Error("Azure OpenAI chat failed"), { status: 404, code: "DeploymentNotFound" });
    // Simulates ChatTurnLifecycle.recordFailure reporting this exact error before
    // ChatService rethrows it, which a stream:false route's catch then hands to
    // next(error) — reaching this branch with headers never sent.
    await service.report({ errorType: "chat.turn_failed", error });
    expect(sink.record).toHaveBeenCalledOnce();

    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeUnsentRes();

    handler(error, fakeReq(), res, next);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("still reports an unreported, unstructured error once", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeUnsentRes();

    handler(new Error("boom"), fakeReq(), res, next);
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("reports a 5xx AppError once with its status, and still answers with the AppError's own body", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const res = fakeUnsentRes();

    handler(serviceUnavailable("Access grants are not configured."), fakeReq(), res, vi.fn());
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(vi.mocked(sink.record).mock.calls[0]?.[0]).toMatchObject({
      errorType: "http.request.unhandled",
      requestContext: { statusCode: 503 },
    });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "service_unavailable", message: "Access grants are not configured.", details: undefined },
    });
  });

  it("reports a platform misconfiguration (ProviderConfigurationError, AppError 503) answered before any byte was sent", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const res = fakeUnsentRes();
    const error = new ProviderConfigurationError("No API key configured for provider \"openai\".", {
      kind: "missing_api_key",
      provider: "openai",
      capability: "chat",
      remediation: "Add a workspace credential.",
    });

    handler(error, fakeReq(), res, vi.fn());
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("reports a 5xx structured error that is not an AppError instance (the Enterprise error shape)", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const res = fakeUnsentRes();
    const error = Object.assign(new Error("Billing provider unavailable"), { statusCode: 502, code: "bad_gateway" });

    handler(error, fakeReq(), res, vi.fn());
    await vi.waitFor(() => expect(sink.record).toHaveBeenCalledOnce());

    expect(vi.mocked(sink.record).mock.calls[0]?.[0]).toMatchObject({ requestContext: { statusCode: 502 } });
    expect(res.status).toHaveBeenCalledWith(502);
  });

  it("never reports a client-facing error under 500, AppError or structured", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);

    handler(new AppError(400, "validation_error", "bad input"), fakeReq(), fakeUnsentRes(), vi.fn());
    handler(
      Object.assign(new Error("Usage limit reached"), { statusCode: 429, code: "usage_limit_exceeded" }),
      fakeReq(),
      fakeUnsentRes(),
      vi.fn(),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).not.toHaveBeenCalled();
  });

  it("never reports a 5xx error marked as an expected outcome (a disconnect-abort turn)", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const handler = createErrorHandler(service);
    const res = fakeUnsentRes();

    handler(new ChatTurnDisconnectAbortError("conv_1", "rendering"), fakeReq(), res, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("does not report a 5xx AppError a caller already reported", async () => {
    const sink: ErrorSink = { name: "test-sink", record: vi.fn().mockResolvedValue(undefined) };
    const service = buildService(sink);
    const error = serviceUnavailable("Public chat response is unavailable.");
    await service.report({ errorType: "chat.turn_failed", error });

    createErrorHandler(service)(error, fakeReq(), fakeUnsentRes(), vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sink.record).toHaveBeenCalledOnce();
  });
});
