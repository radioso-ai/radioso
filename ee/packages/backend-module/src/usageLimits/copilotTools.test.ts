import { describe, expect, it, vi } from "vitest";

import { createUsageLimitCopilotToolContribution } from "./copilotTools.js";
import type { AccountUsageSummary } from "./usageLimitService.js";

const summary = (overrides: Partial<AccountUsageSummary> = {}): AccountUsageSummary => ({
  accountId: "account-1",
  profile: {
    key: "starter_100",
    displayName: "Starter",
    monthlyAnswerLimit: 100,
    storedDocumentLimit: 50,
    storedIndexedByteLimit: null,
    monthlyIndexedByteLimit: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 92, limit: 100 },
  storedDocuments: { used: 12, limit: 50 },
  storedIndexedBytes: { used: 2048, limit: null },
  monthlyIndexedBytes: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 1024, limit: null },
  ...overrides,
});

const toolContext = { workspaceId: "workspace-1", accountId: "account-1", operatorUserId: "operator-1" };
const invocation = { signal: new AbortController().signal, stepIndex: 0, callId: "call-1" };

describe("usage limit copilot contribution", () => {
  it("declares the identities its provenance cites, since the OSS registries do not describe EE", () => {
    const contribution = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage: vi.fn() } });
    const [descriptor] = contribution.descriptors;

    expect(Object.keys(contribution.operationPermissions ?? {}))
      .toEqual(descriptor!.capabilityProvenance.backingOperationIds);
    expect(Object.keys(contribution.applicationPrimitives ?? {}))
      .toEqual(descriptor!.capabilityProvenance.applicationPrimitiveIds);
  });

  it("is a read gated on a workspace permission the copilot turn route resolves", () => {
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage: vi.fn() } }).descriptors;

    expect(descriptor).toMatchObject({
      name: "workspace_usage_limits",
      shape: "read",
      contributingModule: "usageLimits",
      requiredPermissions: ["workspace.settings.read"],
    });
  });

  it("reports what remains against each limit, reading the account the turn runs for", async () => {
    const getAccountUsage = vi.fn(async () => summary());
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor!.createTool(toolContext).invoke({}, invocation);

    expect(getAccountUsage).toHaveBeenCalledWith("account-1");
    expect(result).toEqual({
      planName: "Starter",
      monthlyAnswers: { used: 92, limit: 100, remaining: 8, resetAt: "2026-09-01" },
      storedDocuments: { used: 12, limit: 50, remaining: 38, resetAt: null },
      // An unlimited plan has no remaining figure; reporting 0 would read as exhausted.
      storedIndexedBytes: { used: 2048, limit: null, remaining: null, resetAt: null },
      monthlyIndexedBytes: { used: 1024, limit: null, remaining: null, resetAt: "2026-09-01" },
    });
  });

  it("never reports negative headroom for an account already over its limit", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 140, limit: 100 },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor!.createTool(toolContext).invoke({}, invocation) as { monthlyAnswers: { remaining: number } };

    expect(result.monthlyAnswers.remaining).toBe(0);
  });

  it("returns a result its own output schema accepts, since the catalog validates tool output", async () => {
    const getAccountUsage = vi.fn(async () => summary({ profile: null }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;
    const tool = descriptor!.createTool(toolContext);

    expect(tool.outputSchema.safeParse(await tool.invoke({}, invocation)).success).toBe(true);
  });
});
