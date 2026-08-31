import { z } from "zod";

import type { CopilotToolContribution, CopilotToolDescriptor } from "../radiosoModuleTypes.js";

import type { AccountUsageSummary } from "./usageLimitService.js";

/** The one read this contribution needs; the service itself owns reservation and enforcement. */
export interface CopilotAccountUsagePort {
  getAccountUsage(accountId: string): Promise<AccountUsageSummary>;
}

const usageWindowSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  resetAt: z.string().nullable(),
});

const outputSchema = z.object({
  planName: z.string().nullable(),
  monthlyAnswers: usageWindowSchema,
  storedDocuments: usageWindowSchema,
  storedIndexedBytes: usageWindowSchema,
  monthlyIndexedBytes: usageWindowSchema,
});

/** `null` limit means unlimited, so remaining is unknowable rather than zero. */
const window = (
  entry: { used: number; limit: number | null; resetAt?: string },
): z.infer<typeof usageWindowSchema> => ({
  used: entry.used,
  limit: entry.limit,
  remaining: entry.limit === null ? null : Math.max(0, entry.limit - entry.used),
  resetAt: entry.resetAt ?? null,
});

const usageDescriptor = (deps: { usage: CopilotAccountUsagePort }): CopilotToolDescriptor => ({
  name: "workspace_usage_limits",
  shape: "read",
  uiLabel: "Reading plan usage and limits",
  description:
    "Read the plan and current-period usage for this workspace's organization: answers, stored documents, and indexed content, each with its limit and what remains. Use it before advising on ingestion or before proposing configuration whose cost depends on volume.",
  inputSchema: z.object({}).strict(),
  outputSchema,
  // Strictly stricter than the tenant-facing route this mirrors, which is gated on an account
  // session alone. Usage is organization-scoped, so the numbers cover every workspace in the org.
  requiredPermissions: ["workspace.settings.read"],
  capabilityProvenance: {
    backingOperationIds: ["getEnterpriseAccountUsage"],
    applicationPrimitiveIds: ["usageLimits.account-usage.read"],
  },
  contributingModule: "usageLimits",
  dashboardSubject: { type: "workspace_settings" },
  createTool: (context) => ({
    name: "workspace_usage_limits",
    description: "Read plan usage and limits.",
    inputSchema: z.object({}).strict(),
    outputSchema,
    invoke: async () => {
      const usage = await deps.usage.getAccountUsage(context.accountId);
      return {
        planName: usage.profile?.displayName ?? null,
        monthlyAnswers: window(usage.monthlyAnswers),
        storedDocuments: window(usage.storedDocuments),
        storedIndexedBytes: window(usage.storedIndexedBytes),
        monthlyIndexedBytes: window(usage.monthlyIndexedBytes),
      };
    },
  }),
});

export const createUsageLimitCopilotToolContribution = (
  deps: { usage: CopilotAccountUsagePort },
): CopilotToolContribution => ({
  moduleId: "radioso-enterprise-usage-limits",
  descriptors: [usageDescriptor(deps)],
  // EE routes mount outside the OSS OpenAPI document, so this contribution names its own operation
  // and the permissions that route requires. `/api/v1/ee/usage-limits/me` is gated on an account
  // session with no workspace permission, which the descriptor above deliberately tightens.
  operationPermissions: { getEnterpriseAccountUsage: [] },
  applicationPrimitives: {
    "usageLimits.account-usage.read": { owningModule: "usageLimits", exportedPort: "EnterpriseUsageLimitService" },
  },
});
