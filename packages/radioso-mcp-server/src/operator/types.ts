import type { AuditLogger } from "../audit/auditLogger.js";
import type { OperatorBackendAdapter } from "./backendAdapter.js";
import type { OperatorProtectedResourceConfig } from "./protectedResource.js";
import type { OperatorRequestRateLimit, OperatorRequestReadiness } from "./requestHandler.js";
import type { OperatorMcpMetrics } from "./observability.js";

export interface OperatorHttpDependencies {
  adapter: OperatorBackendAdapter;
  auditLogger?: AuditLogger;
  metrics?: OperatorMcpMetrics;
  principalRateLimit?: OperatorRequestRateLimit;
  rateLimit?: OperatorRequestRateLimit;
  readiness?: OperatorRequestReadiness;
  resource: OperatorProtectedResourceConfig & { metadataUrl: string };
}
