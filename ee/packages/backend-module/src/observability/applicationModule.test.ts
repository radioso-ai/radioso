import { describe, expect, it, vi } from "vitest";

import { createEnterpriseObservabilityApplicationModule } from "./applicationModule.js";
import { PosthogAnalyticsSink } from "./posthogAnalyticsSink.js";
import { PosthogErrorSink } from "./posthogErrorSink.js";
import { SentryErrorSink } from "./sentryErrorSink.js";

describe("enterprise observability module", () => {
  it("registers hosted vendor sinks only when configured", () => {
    const productAnalyticsSinks: unknown[] = [];
    const errorSinks: unknown[] = [];
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
      POSTHOG_HOST: "https://app.posthog.com",
      POSTHOG_API_KEY: "posthog-key",
      ERROR_SINKS: "audit,sentry,posthog",
      SENTRY_DSN: "https://public@example.ingest.sentry.io/123456",
    });

    module.register?.({
      registerProductAnalyticsSink: (sink) => productAnalyticsSinks.push(sink),
      registerErrorSink: (sink) => errorSinks.push(sink),
    } as any);

    expect(productAnalyticsSinks[0]).toBeInstanceOf(PosthogAnalyticsSink);
    expect(errorSinks[0]).toBeInstanceOf(SentryErrorSink);
    expect(errorSinks[1]).toBeInstanceOf(PosthogErrorSink);
    // The OSS `error_sink_failed` line names a failing sink by this.
    expect(errorSinks.map((sink) => (sink as { name?: unknown }).name)).toEqual(["sentry", "posthog"]);
  });

  it("allows core sink names owned by the OSS backend", () => {
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook",
      ERROR_SINKS: "audit,ops_webhook",
    });

    expect(() => module.register?.({} as any)).not.toThrow();
  });

  it("requires vendor credentials only inside the Enterprise module", () => {
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "audit,posthog",
    });

    expect(() => module.register?.({
      registerProductAnalyticsSink: () => {},
    } as any)).toThrow(/POSTHOG_API_KEY|POSTHOG_HOST/);
  });

  it("fails fast when hosted sink names are misspelled", () => {
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "audit,posthogg",
      ERROR_SINKS: "audit,sentyr",
    });

    expect(() => module.register?.({} as any)).toThrow(/PRODUCT_ANALYTICS_SINKS.*posthogg/);
  });

  it("validates hosted sink URLs before registration", () => {
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "posthog",
      POSTHOG_HOST: "not-a-url",
      POSTHOG_API_KEY: "posthog-key",
    });

    expect(() => module.register?.({
      registerProductAnalyticsSink: () => {},
    } as any)).toThrow(/Invalid URL|POSTHOG_HOST/);
  });

  it("fails fast when hosted error sink names are misspelled", () => {
    const module = createEnterpriseObservabilityApplicationModule({
      PRODUCT_ANALYTICS_SINKS: "audit",
      ERROR_SINKS: "audit,sentyr",
    });

    expect(() => module.register?.({} as any)).toThrow(/ERROR_SINKS.*sentyr/);
  });

  it("formats PostHog analytics, PostHog errors, and Sentry exporter requests using HTTP-only adapters", async () => {
    const posthogFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const posthogErrorFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sentryFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const posthogSink = new PosthogAnalyticsSink({
      apiKey: "posthog-key",
      host: "https://app.posthog.com",
      fetchImpl: posthogFetch,
    });
    const posthogErrorSink = new PosthogErrorSink({
      apiKey: "posthog-key",
      host: "https://us.i.posthog.com",
      fetchImpl: posthogErrorFetch,
    });
    const sentrySink = new SentryErrorSink({
      dsn: "https://public@example.ingest.sentry.io/123456",
      fetchImpl: sentryFetch,
    });

    await posthogSink.emit({
      eventName: "chat.citation_clicked",
      timestamp: "2026-04-22T10:00:00.000Z",
      workspaceId: "workspace-1",
      subjectType: "conversation",
      subjectId: "conversation-1",
      source: "frontend",
    });
    await posthogErrorSink.record({
      errorType: "worker.failure",
      timestamp: "2026-04-22T10:00:00.000Z",
      severity: "error",
      service: "radioso-worker",
      environment: "test",
      message: "worker.failure: WorkerError",
      errorClass: "WorkerError",
      stack: [
        "    at runJob (/app/backend/src/worker.ts:10:15)",
        "    at file:///app/backend/src/documentWorker.ts:22:3",
      ].join("\n"),
      fingerprint: "radioso-worker:worker.failure:WorkerError",
      correlation: {
        requestId: "request-1",
      },
    });
    await sentrySink.record({
      errorType: "worker.failure",
      timestamp: "2026-04-22T10:00:00.000Z",
      severity: "error",
      service: "radioso-worker",
      environment: "test",
      message: "worker.failure: WorkerError",
      fingerprint: "radioso-worker:worker.failure:WorkerError",
    });

    expect(posthogFetch).toHaveBeenCalledWith(
      "https://app.posthog.com/i/v0/e/",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(posthogFetch.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({
      event: "chat.citation_clicked",
      distinct_id: "conversation-1",
    }));

    expect(posthogErrorFetch).toHaveBeenCalledWith(
      "https://us.i.posthog.com/i/v0/e/",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const posthogErrorBody = JSON.parse(String(posthogErrorFetch.mock.calls[0]?.[1]?.body));
    expect(posthogErrorBody).toEqual(expect.objectContaining({
      api_key: "posthog-key",
      event: "$exception",
      distinct_id: "request-1",
    }));
    expect(posthogErrorBody.properties).toEqual(expect.objectContaining({
      distinct_id: "request-1",
      "$process_person_profile": false,
      "$exception_level": "error",
      errorType: "worker.failure",
      service: "radioso-worker",
    }));
    expect(posthogErrorBody.properties.$exception_list[0]).toEqual(expect.objectContaining({
      type: "WorkerError",
      value: "worker.failure: WorkerError",
    }));
    expect(posthogErrorBody.properties.$exception_list[0].stacktrace.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: "file:///app/backend/src/documentWorker.ts",
          lineno: 22,
          colno: 3,
        }),
      ]),
    );

    expect(sentryFetch).toHaveBeenCalledWith(
      "https://example.ingest.sentry.io/api/123456/envelope/",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(String(sentryFetch.mock.calls[0]?.[1]?.body)).toContain("\"worker.failure\"");
    expect(String(sentryFetch.mock.calls[0]?.[1]?.body)).toContain("\"worker.failure: WorkerError\"");
  });

  it("sends PostHog the backend's fingerprint, the error's class, code and causes, and every frame of its stack", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sink = new PosthogErrorSink({ apiKey: "posthog-key", host: "https://eu.i.posthog.com/", fetchImpl });

    await sink.record({
      errorType: "document.worker.tick_failed",
      timestamp: "2026-11-08T10:00:00.000Z",
      severity: "error",
      service: "radioso-worker",
      environment: "test",
      message: "document.worker.tick_failed: AppError [service_unavailable] caused by DatabaseError [25P02]",
      errorClass: "AppError",
      code: "service_unavailable",
      causes: [{ errorClass: "DatabaseError", code: "25P02" }],
      // The backend hands a sink frames only, so a stack's first line is already a frame.
      stack: [
        "    at tick (/app/backend/dist/modules/documents/services/documentProcessingWorker.js:391:13)",
        "    at async Promise.all (index 0)",
      ].join("\n"),
      fingerprint: "radioso-worker:document.worker.tick_failed:AppError:service_unavailable",
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.properties).toEqual(expect.objectContaining({
      "$exception_fingerprint": "radioso-worker:document.worker.tick_failed:AppError:service_unavailable",
      code: "service_unavailable",
      causes: [{ errorClass: "DatabaseError", code: "25P02" }],
    }));
    expect(body.properties.$exception_list).toEqual([
      expect.objectContaining({
        type: "AppError",
        value: "document.worker.tick_failed: AppError [service_unavailable] caused by DatabaseError [25P02]",
      }),
    ]);
    expect(body.properties.$exception_list[0].stacktrace.frames).toEqual([
      expect.objectContaining({
        function: "tick",
        filename: "/app/backend/dist/modules/documents/services/documentProcessingWorker.js",
        lineno: 391,
        colno: 13,
        in_app: true,
      }),
      expect.objectContaining({ function: "async Promise.all" }),
    ]);
  });
});
