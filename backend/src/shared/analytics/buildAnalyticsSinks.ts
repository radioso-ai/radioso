import type { Env } from "../../app/config/env.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";
import { hasConfiguredSink } from "../observability/configuredSinks.js";
import { MetricsRegistry } from "../observability/metrics/metricsRegistry.js";
import { AuditEventAnalyticsSink } from "./auditEventAnalyticsSink.js";
import type { ProductAnalyticsEvent } from "./productAnalyticsTypes.js";
import type { ProductAnalyticsSink } from "./productAnalyticsSink.js";

class MetricsProductAnalyticsSink implements ProductAnalyticsSink {
  constructor(private readonly metricsRegistry: MetricsRegistry) {}

  async emit(event: ProductAnalyticsEvent): Promise<void> {
    this.metricsRegistry.incrementCounter("product_events_total", {
      help: "Total first-party product analytics events.",
      labels: {
        event_name: event.eventName,
        source: event.source ?? "unknown",
        subject_type: event.subjectType ?? "unknown",
      },
    });
  }
}

export const buildAnalyticsSinks = (input: {
  auditService: AuditService;
  env: Pick<Env, "PRODUCT_ANALYTICS_SINKS">;
  metricsRegistry: MetricsRegistry | null;
  opsEventSink?: ProductAnalyticsSink | null;
}): ProductAnalyticsSink[] => {
  // Audit is the system of record for product events and is not part of the configurable
  // list; the list decides which additional destinations receive a copy.
  const sinks: ProductAnalyticsSink[] = [new AuditEventAnalyticsSink(input.auditService)];

  if (input.metricsRegistry) {
    sinks.push(new MetricsProductAnalyticsSink(input.metricsRegistry));
  }

  if (input.opsEventSink && hasConfiguredSink(input.env.PRODUCT_ANALYTICS_SINKS, "ops_webhook")) {
    sinks.push(input.opsEventSink);
  }

  return sinks;
};
