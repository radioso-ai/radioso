import { describe, expect, it, vi } from "vitest";

import { buildAnalyticsSinks } from "../../src/shared/analytics/buildAnalyticsSinks.js";
import { buildErrorSinks } from "../../src/shared/errors/buildErrorSinks.js";
import { AuditEventAnalyticsSink } from "../../src/shared/analytics/auditEventAnalyticsSink.js";
import { AuditErrorSink } from "../../src/shared/errors/auditErrorSink.js";
import type { AuditService } from "../../src/modules/audit/contracts/index.js";
import type { ProductAnalyticsSink } from "../../src/shared/analytics/productAnalyticsSink.js";
import type { ErrorSink } from "../../src/shared/errors/errorSink.js";

const auditService = { record: vi.fn() } as unknown as AuditService;
const opsAnalyticsSink: ProductAnalyticsSink = { emit: vi.fn() };
const opsErrorSink: ErrorSink = { record: vi.fn() };

describe("buildAnalyticsSinks", () => {
  it("always keeps the audit sink as the durable record", () => {
    const sinks = buildAnalyticsSinks({
      auditService,
      env: { PRODUCT_ANALYTICS_SINKS: "audit" },
      metricsRegistry: null,
      opsEventSink: opsAnalyticsSink,
    });

    expect(sinks.some((sink) => sink instanceof AuditEventAnalyticsSink)).toBe(true);
    expect(sinks).not.toContain(opsAnalyticsSink);
  });

  it("adds the ops webhook sink when the configured list names it", () => {
    const sinks = buildAnalyticsSinks({
      auditService,
      env: { PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook" },
      metricsRegistry: null,
      opsEventSink: opsAnalyticsSink,
    });

    expect(sinks).toContain(opsAnalyticsSink);
  });

  it("leaves the list alone when no ops sink was built", () => {
    const sinks = buildAnalyticsSinks({
      auditService,
      env: { PRODUCT_ANALYTICS_SINKS: "audit,ops_webhook" },
      metricsRegistry: null,
      opsEventSink: null,
    });

    expect(sinks.every((sink) => sink instanceof AuditEventAnalyticsSink)).toBe(true);
  });
});

describe("buildErrorSinks", () => {
  it("always keeps the audit sink as the durable record", () => {
    const sinks = buildErrorSinks({
      auditService,
      env: { ERROR_SINKS: "audit" },
      metricsRegistry: null,
      opsEventSink: opsErrorSink,
    });

    expect(sinks.some((sink) => sink instanceof AuditErrorSink)).toBe(true);
    expect(sinks).not.toContain(opsErrorSink);
  });

  it("adds the ops webhook sink when the configured list names it", () => {
    const sinks = buildErrorSinks({
      auditService,
      env: { ERROR_SINKS: "audit,ops_webhook" },
      metricsRegistry: null,
      opsEventSink: opsErrorSink,
    });

    expect(sinks).toContain(opsErrorSink);
  });
});
