import { describe, expect, it, vi } from "vitest";

import type { ProductAnalyticsEvent } from "../../src/shared/analytics/productAnalyticsTypes.js";
import type { ErrorEvent } from "../../src/shared/errors/errorTypes.js";
import {
  toOpsEventFromAnalytics,
  toOpsEventFromError,
  type OpsEventEnvelope,
} from "../../src/shared/observability/opsEvents/opsEventEnvelope.js";
import {
  OpsEventDispatcher,
  type OpsEventTransport,
} from "../../src/shared/observability/opsEvents/opsEventDispatcher.js";
import {
  OpsWebhookAnalyticsSink,
  OpsWebhookErrorSink,
} from "../../src/shared/observability/opsEvents/opsEventWebhookSinks.js";
import { SignedWebhookOpsEventTransport } from "../../src/shared/observability/opsEvents/opsEventWebhookTransport.js";
import { verifyWebhookSignature } from "../../src/shared/infra/http/signedWebhook.js";

const silentLogger = () => ({ warn: vi.fn(), error: vi.fn() });

const analyticsEvent = (overrides: Partial<ProductAnalyticsEvent> = {}): ProductAnalyticsEvent => ({
  eventName: "chat.completed",
  timestamp: "2026-09-03T10:00:00.000Z",
  workspaceId: "workspace-1",
  accountId: "account-1",
  actorType: "anonymous_user",
  subjectType: "conversation",
  subjectId: "conversation-1",
  properties: { turnCount: 3 },
  source: "backend",
  ...overrides,
});

const errorEvent = (overrides: Partial<ErrorEvent> = {}): ErrorEvent => ({
  errorType: "http.request.unhandled",
  timestamp: "2026-09-03T10:00:00.000Z",
  severity: "error",
  service: "radioso-api",
  environment: "live",
  message: "boom",
  errorClass: "TypeError",
  stack: "TypeError: boom\n    at handler",
  ...overrides,
});

const collectingTransport = () => {
  const sent: OpsEventEnvelope[] = [];
  const transport: OpsEventTransport = {
    async send(envelope) {
      sent.push(envelope);
    },
  };
  return { sent, transport };
};

describe("ops event envelope", () => {
  it("carries the analytics event under a stable wire shape", () => {
    const envelope = toOpsEventFromAnalytics(analyticsEvent(), "envelope-1");

    expect(envelope).toMatchObject({
      id: "envelope-1",
      kind: "product_analytics",
      name: "chat.completed",
      timestamp: "2026-09-03T10:00:00.000Z",
      severity: "info",
      workspaceId: "workspace-1",
      accountId: "account-1",
    });
    expect(envelope.payload).toMatchObject({ subjectId: "conversation-1", properties: { turnCount: 3 } });
  });

  it("carries the error event with its own severity and class", () => {
    const envelope = toOpsEventFromError(errorEvent({ severity: "warn" }), "envelope-2");

    expect(envelope).toMatchObject({
      id: "envelope-2",
      kind: "error",
      name: "http.request.unhandled",
      severity: "warn",
    });
    expect(envelope.payload).toMatchObject({ errorClass: "TypeError", message: "boom" });
  });
});

describe("OpsEventDispatcher", () => {
  it("returns before the transport completes so it never blocks a request", async () => {
    let releaseSend: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const transport: OpsEventTransport = { send: () => inFlight };
    const dispatcher = new OpsEventDispatcher({ transport, logger: silentLogger() });

    const sink = new OpsWebhookAnalyticsSink(dispatcher, {});
    let emitResolved = false;
    await sink.emit(analyticsEvent()).then(() => {
      emitResolved = true;
    });

    expect(emitResolved).toBe(true);
    releaseSend?.();
    await dispatcher.flush();
  });

  it("delivers queued events in order", async () => {
    const { sent, transport } = collectingTransport();
    const dispatcher = new OpsEventDispatcher({ transport, logger: silentLogger() });

    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "a"));
    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "b"));
    await dispatcher.flush();

    expect(sent.map((envelope) => envelope.id)).toEqual(["a", "b"]);
  });

  it("drops the oldest event when the queue is full rather than growing without bound", async () => {
    const { sent, transport } = collectingTransport();
    const logger = silentLogger();
    const dispatcher = new OpsEventDispatcher({ transport, logger, queueLimit: 2, autoDrain: false });

    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "a"));
    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "b"));
    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "c"));
    await dispatcher.flush();

    expect(sent.map((envelope) => envelope.id)).toEqual(["b", "c"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("retries a failing delivery and gives up after the attempt limit", async () => {
    const send = vi.fn().mockRejectedValue(new Error("503"));
    const logger = silentLogger();
    const dispatcher = new OpsEventDispatcher({
      transport: { send },
      logger,
      maxAttempts: 3,
      sleep: async () => {},
    });

    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "a"));
    await dispatcher.flush();

    expect(send).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it("keeps draining after one event exhausts its retries", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValue(undefined);
    const dispatcher = new OpsEventDispatcher({
      transport: { send },
      logger: silentLogger(),
      maxAttempts: 1,
      sleep: async () => {},
    });

    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "a"));
    dispatcher.enqueue(toOpsEventFromAnalytics(analyticsEvent(), "b"));
    await dispatcher.flush();

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("ops webhook sinks", () => {
  it("forwards every analytics event when no allowlist is configured", async () => {
    const { sent, transport } = collectingTransport();
    const dispatcher = new OpsEventDispatcher({ transport, logger: silentLogger() });
    const sink = new OpsWebhookAnalyticsSink(dispatcher, {});

    await sink.emit(analyticsEvent({ eventName: "chat.completed" }));
    await sink.emit(analyticsEvent({ eventName: "chat.started" }));
    await dispatcher.flush();

    expect(sent.map((envelope) => envelope.name)).toEqual(["chat.completed", "chat.started"]);
  });

  it("forwards only allowlisted analytics events", async () => {
    const { sent, transport } = collectingTransport();
    const dispatcher = new OpsEventDispatcher({ transport, logger: silentLogger() });
    const sink = new OpsWebhookAnalyticsSink(dispatcher, { eventNames: new Set(["account.registered"]) });

    await sink.emit(analyticsEvent({ eventName: "chat.started" }));
    await sink.emit(analyticsEvent({ eventName: "account.registered" }));
    await dispatcher.flush();

    expect(sent.map((envelope) => envelope.name)).toEqual(["account.registered"]);
  });

  it("forwards errors at or above the configured severity", async () => {
    const { sent, transport } = collectingTransport();
    const dispatcher = new OpsEventDispatcher({ transport, logger: silentLogger() });
    const sink = new OpsWebhookErrorSink(dispatcher, { minSeverity: "warn" });

    await sink.record(errorEvent({ severity: "info" }));
    await sink.record(errorEvent({ severity: "warn" }));
    await sink.record(errorEvent({ severity: "error" }));
    await dispatcher.flush();

    expect(sent.map((envelope) => envelope.severity)).toEqual(["warn", "error"]);
  });
});

describe("SignedWebhookOpsEventTransport", () => {
  it("signs the body it posts and uses the envelope id as the idempotency key", async () => {
    const posted: Array<{ url: string; rawBody: string; headers: Record<string, string> }> = [];
    const transport = new SignedWebhookOpsEventTransport(
      { post: async (request) => { posted.push(request); } },
      { url: "https://ops.example/hook", secret: "shhh" },
    );

    const envelope = toOpsEventFromAnalytics(analyticsEvent(), "envelope-1");
    await transport.send(envelope);

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("https://ops.example/hook");
    expect(posted[0].headers["Idempotency-Key"]).toBe("envelope-1");
    expect(verifyWebhookSignature({
      rawBody: posted[0].rawBody,
      secret: "shhh",
      timestamp: posted[0].headers["X-Radioso-Timestamp"],
      signatureHeader: posted[0].headers["X-Radioso-Signature"],
    })).toBe(true);
  });
});
