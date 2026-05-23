import type { CorrelationFields } from "../observability/telemetry/correlation.js";

export type ErrorSeverity = "info" | "warn" | "error";

export interface ErrorRequestContext {
  method?: string;
  route?: string;
  statusCode?: number;
}

export interface ErrorEvent {
  errorType: string;
  timestamp: string;
  severity: ErrorSeverity;
  service: string;
  environment: string;
  version?: string;
  message: string;
  errorClass?: string;
  stack?: string;
  correlation?: CorrelationFields;
  requestContext?: ErrorRequestContext;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}
