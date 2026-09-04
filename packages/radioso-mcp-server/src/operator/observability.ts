import type { AuditLogger } from "../audit/auditLogger.js";
import { createFixedWindowPreAuthSourceBudget, type PreAuthSourceBudget } from "../http/preAuthSourceBudget.js";

export type OperatorMcpMethod = "ping" | "tools/list" | "tools/call";
export type OperatorMcpOutcome = "success" | "denied" | "error";
export type OperatorMcpShape = "read" | "probe" | "act" | "propose";
export type OperatorMcpReason = "invalid_request" | "invalid_token" | "insufficient_scope" | "rate_limit_exceeded" | "runtime_unavailable";

export interface OperatorMcpAuditObservation {
  readonly method: OperatorMcpMethod;
  readonly outcome: OperatorMcpOutcome;
  readonly descriptorName?: string;
  readonly shape?: OperatorMcpShape;
  readonly reason?: OperatorMcpReason;
  /** Transport/auth data is accepted for call-site ergonomics but intentionally never emitted. */
  readonly accessToken?: unknown;
  readonly arguments?: unknown;
  readonly clientId?: unknown;
  readonly userId?: unknown;
  readonly workspaceId?: unknown;
}

const SAFE_DESCRIPTOR = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

const safeAuditMetadata = (input: OperatorMcpAuditObservation): Record<string, string> => {
  const metadata: Record<string, string> = {
    method: input.method,
    surface: "operator_mcp",
  };
  if (input.descriptorName && SAFE_DESCRIPTOR.test(input.descriptorName)) metadata.descriptorName = input.descriptorName;
  if (input.shape) metadata.shape = input.shape;
  if (input.reason) metadata.reason = input.reason;
  return metadata;
};

export const createOperatorAuditObserver = (auditLogger: Pick<AuditLogger, "emit">) => async (input: OperatorMcpAuditObservation): Promise<void> => {
  await auditLogger.emit({
    eventType: "operator_mcp_method",
    metadata: safeAuditMetadata(input),
    outcome: input.outcome,
  });
};

export interface OperatorMcpMetricObservation extends OperatorMcpAuditObservation {}

export interface OperatorMcpMetrics {
  observe(input: OperatorMcpMetricObservation): void;
  snapshot(): ReadonlyArray<{
    labels: { method: OperatorMcpMethod; outcome: OperatorMcpOutcome; surface: "operator_mcp" };
    count: number;
  }>;
}

export const createOperatorMcpMetrics = (): OperatorMcpMetrics => {
  const counts = new Map<string, { method: OperatorMcpMethod; outcome: OperatorMcpOutcome; count: number }>();
  return {
    observe(input) {
      const key = `${input.method}|${input.outcome}`;
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { method: input.method, outcome: input.outcome, count: 1 });
    },
    snapshot() {
      return [...counts.values()].map(({ method, outcome, count }) => ({
        labels: { method, outcome, surface: "operator_mcp" as const },
        count,
      }));
    },
  };
};

export interface OperatorMcpFloodLimiter {
  readonly source: PreAuthSourceBudget;
  readonly principal: PreAuthSourceBudget;
}

export const createOperatorMcpFloodLimiter = (input: {
  maxAttempts?: number;
  windowMs?: number;
  maxSources?: number;
  maxPrincipals?: number;
} = {}): OperatorMcpFloodLimiter => ({
  source: createFixedWindowPreAuthSourceBudget({
    maxAttempts: input.maxAttempts ?? 120,
    maxSources: input.maxSources ?? 1_024,
    windowMs: input.windowMs ?? 60_000,
  }),
  principal: createFixedWindowPreAuthSourceBudget({
    maxAttempts: input.maxAttempts ?? 120,
    maxSources: input.maxPrincipals ?? 2_048,
    windowMs: input.windowMs ?? 60_000,
  }),
});
