import { z } from "zod";

import type { CopilotToolContribution, CopilotToolDescriptor } from "../radiosoModuleTypes.js";

import type { AccountUsageSummary } from "./usageLimitService.js";

const planNameMaxLength = 200;
const resetAtSchema = z.string().datetime({ offset: true }).max(35).nullable();

/** The one read this contribution needs; the service itself owns reservation and enforcement. */
interface CopilotAccountUsagePort {
  getAccountUsage(accountId: string): Promise<AccountUsageSummary>;
}

const usageWindowSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  resetAt: resetAtSchema,
});

const usageLevelSchema = z.enum(["ok", "nearing_limit", "limit_reached", "grace_exhausted"]);

const graceSchema = z.object({
  limit: z.number().nonnegative(),
  borrowed: z.number().nonnegative(),
});

// Conversation metering counts in tenths (ten test runs make one conversation), so used/limit/remaining
// can land on a fractional value like 0.5; every other window counts whole units. Conversations also
// carry the account-wide grace allowance and resulting level, which no other metered dimension has.
const fractionalUsageWindowSchema = z.object({
  used: z.number().nonnegative(),
  limit: z.number().nonnegative().nullable(),
  remaining: z.number().nonnegative().nullable(),
  resetAt: resetAtSchema,
  capacity: z.number().nonnegative(),
  grace: graceSchema,
  level: usageLevelSchema,
});

const outputSchema = z.object({
  planName: z.string().max(planNameMaxLength).nullable(),
  /**
   * Null when the plan meters conversations rather than answers. A conversation-metered
   * profile leaves `monthlyAnswerLimit` unenforced (EnterpriseUsageLimitService.getAccountUsage),
   * so a raw `{ limit: null }` here would read as "unlimited answers" rather than "see
   * monthlyConversations instead" — the bug #1301 reported. Omitting the field makes the
   * dormancy explicit instead of indistinguishable from a true no-cap answer plan.
   */
  monthlyAnswers: usageWindowSchema.nullable(),
  storedDocuments: usageWindowSchema,
  storedIndexedBytes: usageWindowSchema,
  monthlyIndexedBytes: usageWindowSchema,
  /** Null when the plan meters answers rather than conversations. */
  monthlyConversations: fractionalUsageWindowSchema.nullable(),
});

/** `null` limit means unlimited, so remaining is unknowable rather than zero. */
const window = (
  entry: { used: number; limit: number | null; resetAt?: string },
): z.infer<typeof usageWindowSchema> => ({
  used: entry.used,
  limit: entry.limit,
  remaining: entry.limit === null ? null : Math.max(0, entry.limit - entry.used),
  resetAt: formatResetAt(entry.resetAt),
});

/** Adds the account-wide grace allowance and level on top of the plain usage window — the
 *  conversation-metered dimension's only fields the others don't carry. */
const conversationWindow = (
  entry: NonNullable<AccountUsageSummary["monthlyConversations"]>,
): z.infer<typeof fractionalUsageWindowSchema> => ({
  ...window(entry),
  capacity: entry.capacity,
  grace: entry.grace,
  level: entry.level,
});

/** The usage owner stores monthly boundaries as dates; MCP exposes an explicit UTC instant. */
const formatResetAt = (value: string | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Shared verbatim between the descriptor (what the operator-MCP catalog lists, mcpCatalog.ts)
// and the created tool (what the dashboard model reads, defaultAgentRuntime.ts) — see the
// convention every other descriptor in this module follows. #1301 found the two surfaces
// quoting different, divergent copy for this tool.
const usageToolDescription =
  "Read the plan and current-period usage for this workspace's organization: conversations or "
  + "answers (a plan meters exactly one), stored documents, and indexed content, each with its "
  + "limit and what remains. The dimension a plan does not meter reports null rather than "
  + "unlimited, because that cap is dormant — read whichever of monthlyConversations or "
  + "monthlyAnswers is non-null. Use it before advising on ingestion or before proposing "
  + "configuration whose cost depends on volume.";

const usageDescriptor = (deps: { usage: CopilotAccountUsagePort }): CopilotToolDescriptor => ({
  name: "workspace_usage_limits",
  shape: "read",
  verificationCost: () => 0,
  uiLabel: "Reading plan usage and limits",
  description: usageToolDescription,
  inputSchema: z.object({}).strict(),
  outputSchema,
  // Strictly stricter than the tenant-facing route this mirrors, which is gated on an account
  // session alone. Usage is organization-scoped, so the numbers cover every workspace in the org.
  requiredPermissions: ["workspace.settings.read"],
  mcpDisposition: {
    status: "eligible",
    inputStrategy: "explicit",
    scope: "operator:read",
    retry: { effect: "none", idempotent: true, operationIdentity: "client" },
  },
  capabilityProvenance: {
    backingOperationIds: ["getEnterpriseAccountUsage"],
    applicationPrimitiveIds: ["usageLimits.account-usage.read"],
  },
  contributingModule: "usageLimits",
  dashboardSubject: { type: "workspace_settings" },
  createTool: (context) => ({
    name: "workspace_usage_limits",
    description: usageToolDescription,
    inputSchema: z.object({}).strict(),
    outputSchema,
    invoke: async () => {
      const usage = await deps.usage.getAccountUsage(context.accountId);
      // monthlyConversations is non-null exactly when the profile meters conversations
      // (EnterpriseUsageLimitService.readConversationUsage), which is also when it leaves
      // monthlyAnswers.limit null without enforcing it. Reporting that dormant window here
      // would read as "answers are unlimited" instead of "see monthlyConversations".
      const conversationMetered = usage.monthlyConversations !== null;
      return {
        planName: usage.profile?.displayName.slice(0, planNameMaxLength) ?? null,
        monthlyAnswers: conversationMetered ? null : window(usage.monthlyAnswers),
        storedDocuments: window(usage.storedDocuments),
        storedIndexedBytes: window(usage.storedIndexedBytes),
        monthlyIndexedBytes: window(usage.monthlyIndexedBytes),
        monthlyConversations: usage.monthlyConversations ? conversationWindow(usage.monthlyConversations) : null,
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
