import type { CorrelationFields } from "../observability/telemetry/correlation.js";

export type IncidentSeverity = "info" | "warn" | "error";

export interface IncidentRequestContext {
  method?: string;
  route?: string;
  statusCode?: number;
}

export interface IncidentEvent {
  incidentType: string;
  timestamp: string;
  severity: IncidentSeverity;
  service: string;
  environment: string;
  version?: string;
  message: string;
  errorClass?: string;
  stack?: string;
  correlation?: CorrelationFields;
  requestContext?: IncidentRequestContext;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}
