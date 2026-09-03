import type { Env } from "../../app/config/env.js";
import type { AuditService } from "../../modules/audit/contracts/index.js";
import { hasConfiguredSink } from "../observability/configuredSinks.js";
import { MetricsRegistry } from "../observability/metrics/metricsRegistry.js";
import { AuditErrorSink } from "./auditErrorSink.js";
import type { ErrorSink } from "./errorSink.js";
import type { ErrorEvent } from "./errorTypes.js";

class MetricsErrorSink implements ErrorSink {
  constructor(private readonly metricsRegistry: MetricsRegistry) {}

  async record(event: ErrorEvent): Promise<void> {
    this.metricsRegistry.incrementCounter("errors_total", {
      help: "Total recorded errors.",
      labels: {
        error_type: event.errorType,
        severity: event.severity,
      },
    });
  }
}

export const buildErrorSinks = (input: {
  auditService: AuditService;
  env: Pick<Env, "ERROR_SINKS">;
  metricsRegistry: MetricsRegistry | null;
  opsEventSink?: ErrorSink | null;
}): ErrorSink[] => {
  // Audit is the system of record for errors and is not part of the configurable list;
  // the list decides which additional destinations receive a copy.
  const sinks: ErrorSink[] = [new AuditErrorSink(input.auditService)];

  if (input.metricsRegistry) {
    sinks.push(new MetricsErrorSink(input.metricsRegistry));
  }

  if (input.opsEventSink && hasConfiguredSink(input.env.ERROR_SINKS, "ops_webhook")) {
    sinks.push(input.opsEventSink);
  }

  return sinks;
};
