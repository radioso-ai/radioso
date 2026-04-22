import type { Env } from "../../app/config/env.js";
import { SentryIncidentSink } from "../../integrations/sentry/sentryIncidentSink.js";
import type { AuditService } from "../../modules/audit/services/auditService.js";
import { MetricsRegistry } from "../observability/metrics/metricsRegistry.js";
import { hasConfiguredSink } from "../observability/configuredSinks.js";
import { AuditIncidentSink } from "./auditIncidentSink.js";
import type { IncidentSink } from "./incidentSink.js";
import type { IncidentEvent } from "./incidentTypes.js";

class MetricsIncidentSink implements IncidentSink {
  constructor(private readonly metricsRegistry: MetricsRegistry) {}

  async record(event: IncidentEvent): Promise<void> {
    this.metricsRegistry.incrementCounter("incidents_total", {
      help: "Total recorded incidents.",
      labels: {
        incident_type: event.incidentType,
        severity: event.severity,
      },
    });
  }
}

export const buildIncidentSinks = (input: {
  auditService: AuditService;
  env: Pick<Env, "INCIDENT_SINKS" | "SENTRY_DSN">;
  metricsRegistry: MetricsRegistry | null;
}): IncidentSink[] => {
  const sinks: IncidentSink[] = [new AuditIncidentSink(input.auditService)];

  if (input.metricsRegistry) {
    sinks.push(new MetricsIncidentSink(input.metricsRegistry));
  }

  if (hasConfiguredSink(input.env.INCIDENT_SINKS, "sentry")) {
    sinks.push(new SentryIncidentSink({
      dsn: input.env.SENTRY_DSN!,
    }));
  }

  return sinks;
};
