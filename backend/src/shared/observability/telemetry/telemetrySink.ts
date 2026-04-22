import type { CorrelationFields } from "./correlation.js";

export type TelemetrySeverity = "debug" | "info" | "warn" | "error";

export interface TelemetryEvent {
  eventType: string;
  timestamp: string;
  service: string;
  environment: string;
  version?: string;
  severity: TelemetrySeverity;
  correlation?: CorrelationFields;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): Promise<void>;
}

export class NoopTelemetrySink implements TelemetrySink {
  async emit(_event: TelemetryEvent): Promise<void> {}
}
