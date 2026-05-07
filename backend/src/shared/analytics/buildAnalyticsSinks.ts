import type { Env } from "../../app/config/env.js";
import { PosthogAnalyticsSink } from "../../integrations/posthog/posthogAnalyticsSink.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";
import { MetricsRegistry } from "../observability/metrics/metricsRegistry.js";
import { hasConfiguredSink } from "../observability/configuredSinks.js";
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
  env: Pick<Env, "POSTHOG_API_KEY" | "POSTHOG_HOST" | "PRODUCT_ANALYTICS_SINKS">;
  metricsRegistry: MetricsRegistry | null;
}): ProductAnalyticsSink[] => {
  const sinks: ProductAnalyticsSink[] = [new AuditEventAnalyticsSink(input.auditService)];

  if (input.metricsRegistry) {
    sinks.push(new MetricsProductAnalyticsSink(input.metricsRegistry));
  }

  if (hasConfiguredSink(input.env.PRODUCT_ANALYTICS_SINKS, "posthog")) {
    sinks.push(new PosthogAnalyticsSink({
      apiKey: input.env.POSTHOG_API_KEY!,
      host: input.env.POSTHOG_HOST!,
    }));
  }

  return sinks;
};
