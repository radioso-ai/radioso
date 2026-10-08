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
    monthlyConversationLimit: null,
    repliesPerConversation: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 92, limit: 100 },
  storedDocuments: { used: 12, limit: 50 },
  storedIndexedBytes: { used: 2048, limit: null },
  monthlyIndexedBytes: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 1024, limit: null },
  monthlyConversations: null,
  ...overrides,
});

const toolContext = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
};
const invocation = { signal: new AbortController().signal, stepIndex: 0, callId: "call-1" };

describe("usage limit copilot contribution", () => {
  it("declares the identities its provenance cites, since the OSS registries do not describe EE", () => {
    const contribution = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage: vi.fn() } });
    const [descriptor] = contribution.descriptors;

    expect(Object.keys(contribution.operationPermissions ?? {}))
      .toEqual(descriptor.capabilityProvenance.backingOperationIds);
    expect(Object.keys(contribution.applicationPrimitives ?? {}))
      .toEqual(descriptor.capabilityProvenance.applicationPrimitiveIds);
  });

  it("is a read gated on a workspace permission the copilot turn route resolves", () => {
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage: vi.fn() } }).descriptors;

    expect(descriptor).toMatchObject({
      name: "workspace_usage_limits",
      shape: "read",
      contributingModule: "usageLimits",
      requiredPermissions: ["workspace.settings.read"],
      mcpDisposition: {
        status: "eligible",
        inputStrategy: "explicit",
        scope: "operator:read",
        retry: { effect: "none", idempotent: true, operationIdentity: "client" },
      },
    });
  });

  it("reports what remains against each limit, reading the account the turn runs for", async () => {
    const getAccountUsage = vi.fn(async () => summary());
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor.createTool(toolContext).invoke({}, invocation);

    expect(getAccountUsage).toHaveBeenCalledWith("account-1");
    expect(result).toEqual({
      planName: "Starter",
      monthlyAnswers: { used: 92, limit: 100, remaining: 8, resetAt: "2026-09-01T00:00:00.000Z" },
      storedDocuments: { used: 12, limit: 50, remaining: 38, resetAt: null },
      // An unlimited plan has no remaining figure; reporting 0 would read as exhausted.
      storedIndexedBytes: { used: 2048, limit: null, remaining: null, resetAt: null },
      monthlyIndexedBytes: { used: 1024, limit: null, remaining: null, resetAt: "2026-09-01T00:00:00.000Z" },
    monthlyConversations: null,
    });
  });

  it("never reports negative headroom for an account already over its limit", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 140, limit: 100 },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor.createTool(toolContext).invoke({}, invocation) as { monthlyAnswers: { remaining: number } };

    expect(result.monthlyAnswers.remaining).toBe(0);
  });

  it("returns a result its own output schema accepts, since the catalog validates tool output", async () => {
    const getAccountUsage = vi.fn(async () => summary({ profile: null }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;
    const tool = descriptor.createTool(toolContext);

    expect(tool.outputSchema.safeParse(await tool.invoke({}, invocation)).success).toBe(true);
  });

  it("masks the dormant answer cap on a catalog plan, rather than reporting it as unlimited", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      profile: {
        key: "comet",
        displayName: "Comet",
        monthlyAnswerLimit: null,
        storedDocumentLimit: 50,
        storedIndexedByteLimit: null,
        monthlyIndexedByteLimit: null,
        monthlyConversationLimit: 50,
        repliesPerConversation: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      // The service nulls the answer limit for a conversation-metered profile
      // (EnterpriseUsageLimitService.getAccountUsage), the same shape it hands this tool.
      monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 0, limit: null },
      monthlyConversations: {
        periodStart: "2026-08-01",
        resetAt: "2026-09-01",
        used: 12.5,
        limit: 50,
        credits: 0,
        capacity: 50,
        grace: { limit: 5, borrowed: 0 },
        level: "ok",
        byKind: { conversation: 0, copilot: 12.5, test_run: 0, pulse_report: 0 },
      },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor.createTool(toolContext).invoke({}, invocation) as {
      monthlyAnswers: unknown;
      monthlyConversations: unknown;
    };

    expect(result.monthlyAnswers).toBeNull();
    expect(result.monthlyConversations).toEqual({
      used: 12.5,
      limit: 50,
      remaining: 37.5,
      resetAt: "2026-09-01T00:00:00.000Z",
      capacity: 50,
      grace: { limit: 5, borrowed: 0 },
      level: "ok",
    });
  });

  it("still reports a genuinely unlimited answer cap for a plan that meters answers, not conversations", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      profile: {
        key: "enterprise_uncapped",
        displayName: "Enterprise",
        monthlyAnswerLimit: null,
        storedDocumentLimit: null,
        storedIndexedByteLimit: null,
        monthlyIndexedByteLimit: null,
        monthlyConversationLimit: null,
        repliesPerConversation: 10,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      monthlyAnswers: { periodStart: "2026-08-01", resetAt: "2026-09-01", used: 400, limit: null },
      monthlyConversations: null,
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;

    const result = await descriptor.createTool(toolContext).invoke({}, invocation) as {
      monthlyAnswers: unknown;
    };

    expect(result.monthlyAnswers).toEqual({ used: 400, limit: null, remaining: null, resetAt: "2026-09-01T00:00:00.000Z" });
  });

  it("names conversations in its copy, and keeps the dashboard and operator-MCP surfaces reading the same text", () => {
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage: vi.fn() } }).descriptors;

    expect(descriptor.description.toLowerCase()).toContain("conversation");
    // mcpCatalog.ts lists descriptor.description on the operator MCP surface; defaultAgentRuntime.ts
    // sends createTool(...).description to the model on the dashboard surface. One written sentence,
    // not two, so the two surfaces cannot drift the way #1301 found them.
    expect(descriptor.createTool(toolContext).description).toBe(descriptor.description);
  });

  it("accepts fractional monthly-conversation metering, since ten test runs make one conversation", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      monthlyConversations: {
        periodStart: "2026-08-01",
        resetAt: "2026-09-01",
        used: 0.5,
        limit: 100,
        credits: 0,
        capacity: 100,
        grace: { limit: 10, borrowed: 0 },
        level: "ok",
        byKind: { conversation: 0, copilot: 0, test_run: 0.5, pulse_report: 0 },
      },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;
    const tool = descriptor.createTool(toolContext);

    const result = await tool.invoke({}, invocation);

    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect((result as { monthlyConversations: unknown }).monthlyConversations).toEqual({
      used: 0.5,
      limit: 100,
      remaining: 99.5,
      resetAt: "2026-09-01T00:00:00.000Z",
      capacity: 100,
      grace: { limit: 10, borrowed: 0 },
      level: "ok",
    });
  });

  it("reports remaining against capacity, not the plan limit alone, once credits extend past the limit", async () => {
    // limit 1000, used 1050, 250 credits left: capacity 1300, so 250 conversations remain.
    // `limit - used` alone would read -50, clamp to 0, and hide those 250 credits entirely.
    const getAccountUsage = vi.fn(async () => summary({
      monthlyConversations: {
        periodStart: "2026-08-01",
        resetAt: "2026-09-01",
        used: 1050,
        limit: 1000,
        credits: 250,
        capacity: 1300,
        grace: { limit: 100, borrowed: 0 },
        level: "ok",
        byKind: { conversation: 1050, copilot: 0, test_run: 0, pulse_report: 0 },
      },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;
    const tool = descriptor.createTool(toolContext);

    const result = await tool.invoke({}, invocation);

    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect((result as { monthlyConversations: { remaining: number } }).monthlyConversations.remaining).toBe(250);
  });

  it("surfaces the account-wide grace allowance and level once a conversation has borrowed", async () => {
    const getAccountUsage = vi.fn(async () => summary({
      monthlyConversations: {
        periodStart: "2026-08-01",
        resetAt: "2026-09-01",
        used: 110,
        limit: 100,
        credits: 0,
        capacity: 110,
        grace: { limit: 10, borrowed: 10 },
        level: "grace_exhausted",
        byKind: { conversation: 110, copilot: 0, test_run: 0, pulse_report: 0 },
      },
    }));
    const [descriptor] = createUsageLimitCopilotToolContribution({ usage: { getAccountUsage } }).descriptors;
    const tool = descriptor.createTool(toolContext);

    const result = await tool.invoke({}, invocation);

    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect((result as { monthlyConversations: unknown }).monthlyConversations).toMatchObject({
      capacity: 110,
      grace: { limit: 10, borrowed: 10 },
      level: "grace_exhausted",
    });
  });
});
