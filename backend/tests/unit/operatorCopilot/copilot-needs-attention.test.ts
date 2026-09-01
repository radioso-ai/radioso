import { describe, expect, it, vi } from "vitest";

import { createNeedsAttentionCopilotTools } from "../../../src/modules/operatorCopilot/tools/needsAttention.js";
import type { NeedsAttentionCopilotToolDependencies } from "../../../src/modules/operatorCopilot/tools/needsAttention.js";

const ALL_PERMISSIONS = new Set([
  "workspace.history.read",
  "workspace.conversation.takeover",
  "workspace.quality.read",
]);

const context = (permissions: ReadonlySet<string> = ALL_PERMISSIONS, agentId: string | null = null) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  permissions,
  currentAuthorization: {
    hasAllPermissions: async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) =>
      requiredPermissions.every((permission) => permissions.has(permission)),
  },
  pageContext: { view: "activity" as const, agentId, conversationId: null, selection: null, entities: [] },
});

const approval = (overrides: Record<string, unknown> = {}) => ({
  handle: "decision-handle-1",
  conversationId: "conversation-approval",
  agentId: "11111111-1111-4111-8111-111111111111",
  reason: "Refund over limit",
  createdAt: new Date("2026-08-26T06:00:00.000Z"),
  ...overrides,
});

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: "conversation-handoff",
  agentId: "11111111-1111-4111-8111-111111111111",
  agentName: "Support",
  preview: "Where is my refund?",
  createdAt: "2026-08-26T04:00:00.000Z",
  updatedAt: "2026-08-26T07:00:00.000Z",
  ownership: {
    state: "human_owned",
    ownerDisplayName: null,
    reason: "escalation",
    takenOverAt: null,
    updatedAt: "2026-08-26T07:00:00.000Z",
  },
  ...overrides,
});

const qualityTurn = (overrides: Record<string, unknown> = {}) => ({
  assistantMessageId: "22222222-2222-4222-8222-222222222222",
  conversationId: "conversation-quality",
  agentId: "11111111-1111-4111-8111-111111111111",
  agentName: "Support",
  question: "Do you ship to Spain?",
  answerPreview: "I could not find that.",
  createdAt: "2026-08-26T05:00:00.000Z",
  feedback: {
    downCount: 1,
    latestDownUpdatedAt: "2026-08-26T08:00:00.000Z",
    comments: [{ value: "down", comment: "This was wrong.", updatedAt: "2026-08-26T08:00:00.000Z" }],
  },
  triage: { state: "open", version: 3 },
  ...overrides,
});

const dependencies = (overrides: Partial<NeedsAttentionCopilotToolDependencies> = {}): NeedsAttentionCopilotToolDependencies => ({
  pendingApprovals: { listPending: vi.fn(async () => []) },
  chatHistoryService: {
    getConversation: vi.fn(),
    getConversationTurn: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [], total: 0 })),
  },
  qualitySignalsService: {
    getQualityStats: vi.fn(async () => ({ backlog: {} })),
    listLowQualityTurns: vi.fn(async () => ({ items: [], total: 0 })),
  },
  workspaceRouteKeyResolver: { resolveWorkspaceKey: vi.fn(async () => "acme") },
  ...overrides,
} as NeedsAttentionCopilotToolDependencies);

const list = async (
  deps: NeedsAttentionCopilotToolDependencies,
  input: Record<string, unknown> = {},
  invocation = context(),
) => {
  const [descriptor] = createNeedsAttentionCopilotTools(deps);
  return descriptor!.createTool(invocation).invoke(input as never, {} as never) as Promise<{
    items: Array<Record<string, unknown>>;
    sources: Array<{ source: string; status: string; total: number | null; included: number }>;
  }>;
};

const populated = (overrides: Partial<NeedsAttentionCopilotToolDependencies> = {}) => dependencies({
  pendingApprovals: { listPending: vi.fn(async () => [approval()]) },
  chatHistoryService: {
    getConversation: vi.fn(),
    getConversationTurn: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [conversation()], total: 1 })),
  },
  qualitySignalsService: {
    getQualityStats: vi.fn(async () => ({ backlog: {} })),
    listLowQualityTurns: vi.fn(async () => ({ items: [qualityTurn()], total: 1 })),
  },
  ...overrides,
});

describe("needs_attention", () => {
  it("declares one read that every operator role can reach", () => {
    const [descriptor] = createNeedsAttentionCopilotTools(dependencies());

    expect(descriptor).toMatchObject({
      name: "needs_attention",
      shape: "read",
      contributingModule: "operatorCopilot",
      // Each source checks its own permission, so requiring the union would take the working list
      // away from the operators who hold only history access.
      requiredPermissions: ["workspace.history.read"],
      dashboardSubject: { type: "needs_attention" },
    });
  });

  it("orders the queue by longest wait and carries the handle each follow-up action needs", async () => {
    const result = await list(populated());

    expect(result.items.map((item) => item.kind)).toEqual(["approval", "handoff", "negative_feedback"]);
    expect(result.items[0]).toMatchObject({
      kind: "approval",
      approvalHandle: "decision-handle-1",
      conversationId: "conversation-approval",
      assistantMessageId: null,
      dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=conversation-approval",
    });
    expect(result.items[1]).toMatchObject({
      kind: "handoff",
      // Null means nobody has claimed it, which is the handoff still waiting on a person.
      takenOverAt: null,
      ownerDisplayName: null,
      approvalHandle: null,
    });
    expect(result.items[2]).toMatchObject({
      kind: "negative_feedback",
      assistantMessageId: "22222222-2222-4222-8222-222222222222",
      // The version the act must echo back, so the row Ray read is the row Ray transitions.
      triageState: "open",
      triageVersion: 3,
    });
  });

  it("reports a source the operator cannot read as unauthorized rather than as an empty queue", async () => {
    const deps = populated();

    const result = await list(deps, {}, context(new Set(["workspace.history.read"])));

    expect(result.items.map((item) => item.kind)).toEqual(["handoff"]);
    expect(result.sources).toEqual(expect.arrayContaining([
      { source: "approvals", status: "unauthorized", total: null, included: 0 },
      { source: "quality", status: "unauthorized", total: null, included: 0 },
      { source: "handoffs", status: "ok", total: 1, included: 1 },
    ]));
  });

  it("reports a source that threw as failed, so a broken read never reads as a clear queue", async () => {
    const deps = populated({
      pendingApprovals: { listPending: vi.fn(async () => { throw new Error("connection reset"); }) },
    });

    const result = await list(deps);

    expect(result.items.map((item) => item.kind)).toEqual(["handoff", "negative_feedback"]);
    expect(result.sources).toContainEqual({ source: "approvals", status: "failed", total: null, included: 0 });
  });

  it("drops a source whose permission is revoked between the read and the merge", async () => {
    // Sources are read concurrently and take different amounts of time. Without the second check a
    // revocation during the slowest read still emits its rows.
    let approvalChecks = 0;
    const invocation = {
      ...context(),
      currentAuthorization: {
        hasAllPermissions: async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) => {
          if (!requiredPermissions.includes("workspace.conversation.takeover")) return true;
          approvalChecks += 1;
          return approvalChecks === 1;
        },
      },
    };

    const result = await list(populated(), {}, invocation);

    expect(approvalChecks).toBe(2);
    expect(result.items.map((item) => item.kind)).toEqual(["handoff", "negative_feedback"]);
    expect(result.sources).toContainEqual({ source: "approvals", status: "unauthorized", total: null, included: 0 });
  });

  it("reports how long each row has been waiting, and who holds a claimed handoff", async () => {
    const claimed = conversation({
      ownership: {
        state: "human_owned",
        ownerDisplayName: "Ada",
        reason: "escalation",
        takenOverAt: "2026-08-26T07:30:00.000Z",
        updatedAt: "2026-08-26T07:00:00.000Z",
      },
    });
    const result = await list(populated({
      chatHistoryService: {
        getConversation: vi.fn(),
        getConversationTurn: vi.fn(),
        listConversations: vi.fn(async () => ({ conversations: [claimed], total: 1 })),
      },
    }), { kinds: ["handoff"] });

    expect(result.items[0]).toMatchObject({
      takenOverAt: "2026-08-26T07:30:00.000Z",
      ownerDisplayName: "Ada",
    });
    expect(result.items[0]!.waitingMinutes).toEqual(expect.any(Number));
    expect(result.items[0]!.waitingMinutes as number).toBeGreaterThanOrEqual(0);
  });

  it("keeps the matched count honest when the page bound drops rows", async () => {
    const result = await list(populated(), { limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.sources).toEqual(expect.arrayContaining([
      { source: "approvals", status: "ok", total: 1, included: 1 },
      { source: "handoffs", status: "ok", total: 1, included: 0 },
      { source: "quality", status: "ok", total: 1, included: 0 },
    ]));
  });

  it("narrows to the requested kinds without reading the sources it excluded", async () => {
    const deps = populated();

    const result = await list(deps, { kinds: ["handoff"] });

    expect(result.items.map((item) => item.kind)).toEqual(["handoff"]);
    expect(result.sources.map((source) => source.source)).toEqual(["handoffs"]);
    expect(deps.pendingApprovals.listPending).not.toHaveBeenCalled();
    expect(deps.qualitySignalsService.listLowQualityTurns).not.toHaveBeenCalled();
  });

  it("scopes every source to the requested agent", async () => {
    const deps = populated({
      pendingApprovals: { listPending: vi.fn(async () => [approval(), approval({ handle: "other", agentId: "44444444-4444-4444-8444-444444444444" })]) },
    });

    const result = await list(deps, { agentId: "11111111-1111-4111-8111-111111111111" });

    expect(result.items.every((item) => item.agentId !== "44444444-4444-4444-8444-444444444444")).toBe(true);
    expect(deps.qualitySignalsService.listLowQualityTurns).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ agentId: "11111111-1111-4111-8111-111111111111" }),
    );
  });
});
