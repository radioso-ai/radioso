import type { AbuseControlPort } from "../../security/contracts/abuseControl.js";

/**
 * Wider than {@link CopilotAuditPort}: the rate-limit record is written on a path where the
 * account or workspace may be unknown, and its status is not always a copilot outcome.
 */
export interface CopilotExpensiveOperationAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * Shared by every copilot capability that spends real model budget on the operator's behalf.
 * Ray's tools do not travel through HTTP routes, so the rate limit the dashboard gets from
 * middleware has to be enforced by the service behind the tool.
 */
export interface CopilotExpensiveOperationGuardDependencies {
  abuseControl: AbuseControlPort;
  audit: CopilotExpensiveOperationAuditPort;
  abusePolicy: { limit: number; windowMs: number };
}
