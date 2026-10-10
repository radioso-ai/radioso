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
    ownerUserId: null,
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

const deliveryFailure = (overrides: Record<string, unknown> = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  conversationId: "conversation-delivery",
  kind: "bounced",
  detailCode: "mailbox_full",
  openedAt: new Date("2026-08-26T05:30:00.000Z"),
  ...overrides,
});

/** The owning reader: the open failures waiting longest, up to the limit, and how many are open. */
const deliveryFailureQueue = (rows: Array<ReturnType<typeof deliveryFailure>>, total = rows.length) => ({
  longestWaiting: vi.fn(async (_workspaceId: string, query: { agentId?: string; limit: number }) => ({
    total,
    items: [...rows].sort((left, right) => left.openedAt.getTime() - right.openedAt.getTime()).slice(0, query.limit),
  })),
});

const dependencies = (overrides: Partial<NeedsAttentionCopilotToolDependencies> = {}): NeedsAttentionCopilotToolDependencies => ({
  pendingApprovals: { listPending: vi.fn(async () => []) },
  deliveryFailures: deliveryFailureQueue([]),
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
});

const list = async (
  deps: NeedsAttentionCopilotToolDependencies,
  input: Record<string, unknown> = {},
  invocation = context(),
) => {
  const [descriptor] = createNeedsAttentionCopilotTools(deps);
  return descriptor.createTool(invocation).invoke(input, {} as never) as Promise<{
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
      { source: "delivery_failures", status: "unauthorized", total: null, included: 0 },
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

    // Delivery failures read under the same permission, so they are left out to count the approvals' checks alone.
    const result = await list(populated(), { kinds: ["approval", "handoff", "negative_feedback"] }, invocation);

    expect(approvalChecks).toBe(2);
    expect(result.items.map((item) => item.kind)).toEqual(["handoff", "negative_feedback"]);
    expect(result.sources).toContainEqual({ source: "approvals", status: "unauthorized", total: null, included: 0 });
  });

  it("reports how long each row has been waiting, and who holds a claimed handoff", async () => {
    const claimed = conversation({
      ownership: {
        state: "human_owned",
        ownerUserId: "user-ada",
        ownerDisplayName: "Ada",
        reason: "escalation",
        takenOverAt: "2026-08-26T07:30:00.000Z",
        updatedAt: "2026-08-26T07:00:00.000Z",
      },
    });
    // Its owner's user is gone, so nobody holds it any more, whatever label it kept.
    const orphaned = conversation({
      id: "conversation-orphaned",
      ownership: {
        state: "human_owned",
        ownerUserId: null,
        ownerDisplayName: "Bea",
        reason: "escalation",
        takenOverAt: "2026-08-26T07:20:00.000Z",
        updatedAt: "2026-08-26T07:10:00.000Z",
      },
    });
    const result = await list(populated({
      chatHistoryService: {
        getConversation: vi.fn(),
        getConversationTurn: vi.fn(),
        listConversations: vi.fn(async () => ({ conversations: [claimed, orphaned], total: 2 })),
      },
    }), { kinds: ["handoff"] });

    expect(result.items[0]).toMatchObject({
      takenOverAt: "2026-08-26T07:30:00.000Z",
      ownerDisplayName: "Ada",
    });
    expect(result.items.find((item) => item.conversationId === "conversation-orphaned")).toMatchObject({
      ownerDisplayName: null,
      takenOverAt: null,
    });
    expect(result.items[0].waitingMinutes).toEqual(expect.any(Number));
    expect(result.items[0].waitingMinutes as number).toBeGreaterThanOrEqual(0);
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

  it("reads the last page of complaints, because the source is newest-first and caps its page", async () => {
    // The owning module clamps a page at 100, so a wider window cannot reach past it. Asking for
    // the last page is exact at every page size — otherwise the longest-waiting complaints are
    // unreachable while `total` reports them as merely paged away.
    const listLowQualityTurns = vi.fn(async () => ({ items: [qualityTurn()], total: 300 }));
    const deps = populated({
      qualitySignalsService: { getQualityStats: vi.fn(async () => ({ backlog: {} })), listLowQualityTurns },
    });

    const result = await list(deps, { kinds: ["negative_feedback"], limit: 25 });

    // The first call is a one-row probe for `total`; a full page would pay for rows it discards.
    expect(listLowQualityTurns).toHaveBeenNthCalledWith(1, "workspace-1", expect.objectContaining({ limit: 1 }));
    expect(listLowQualityTurns).toHaveBeenNthCalledWith(2, "workspace-1", expect.objectContaining({ limit: 25, offset: 275 }));
    // The matched count still describes the whole population, not the page that was read.
    expect(result.sources).toContainEqual({ source: "quality", status: "ok", total: 300, included: 1 });
  });

  it("reads one page when the whole complaint queue fits in it", async () => {
    const listLowQualityTurns = vi.fn(async () => ({ items: [qualityTurn()], total: 1 }));
    const deps = populated({
      qualitySignalsService: { getQualityStats: vi.fn(async () => ({ backlog: {} })), listLowQualityTurns },
    });

    await list(deps, { kinds: ["negative_feedback"] });

    expect(listLowQualityTurns).toHaveBeenCalledTimes(1);
  });

  it("ranks handoffs over a window wider than the page it lists", async () => {
    const listConversations = vi.fn(async () => ({ conversations: [conversation()], total: 1 }));
    const deps = populated({
      chatHistoryService: { getConversation: vi.fn(), getConversationTurn: vi.fn(), listConversations },
    });

    await list(deps, { kinds: ["handoff"], limit: 50 });

    expect(listConversations).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ limit: 500 }));
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

describe("needs_attention delivery failures", () => {
  it("lists a reply that may not have reached the customer by its wait, with its sanitized code", async () => {
    const deps = populated({ deliveryFailures: deliveryFailureQueue([deliveryFailure()]) });

    const result = await list(deps);

    expect(result.items.map((item) => item.kind)).toEqual(["delivery_failed", "approval", "handoff", "negative_feedback"]);
    expect(result.items[0]).toMatchObject({
      kind: "delivery_failed",
      title: "bounced",
      detail: "mailbox_full",
      since: "2026-08-26T05:30:00.000Z",
      conversationId: "conversation-delivery",
      approvalHandle: null,
      assistantMessageId: null,
      dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=conversation-delivery",
    });
    expect(result.sources).toContainEqual({ source: "delivery_failures", status: "ok", total: 1, included: 1 });
  });

  it("reads the failures under the conversation takeover permission and states the gap without it", async () => {
    const deps = populated({ deliveryFailures: deliveryFailureQueue([deliveryFailure()]) });

    const result = await list(deps, {}, context(new Set(["workspace.history.read", "workspace.quality.read"])));

    expect(result.items.map((item) => item.kind)).not.toContain("delivery_failed");
    expect(result.sources).toContainEqual({ source: "delivery_failures", status: "unauthorized", total: null, included: 0 });
    expect(deps.deliveryFailures?.longestWaiting).not.toHaveBeenCalled();
  });

  it("asks the owning reader for only the longest waits it lists, and reports every open failure it counted", async () => {
    const newest = deliveryFailure({ conversationId: "conversation-newest", openedAt: new Date("2026-08-26T09:00:00.000Z") });
    const oldest = deliveryFailure({ conversationId: "conversation-oldest", kind: "halted", detailCode: null, openedAt: new Date("2026-08-26T01:00:00.000Z") });
    const deps = dependencies({ deliveryFailures: deliveryFailureQueue([newest, oldest], 100_000) });

    const result = await list(deps, { kinds: ["delivery_failed"], limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({ conversationId: "conversation-oldest", title: "halted", detail: null })]);
    expect(result.sources).toEqual([{ source: "delivery_failures", status: "ok", total: 100_000, included: 1 }]);
    expect(deps.deliveryFailures?.longestWaiting).toHaveBeenCalledExactlyOnceWith("workspace-1", { limit: 1 });
  });

  it("scopes the failures to the requested agent and reads no other source when asked for this kind alone", async () => {
    const deps = populated({ deliveryFailures: deliveryFailureQueue([deliveryFailure()]) });

    const result = await list(deps, { kinds: ["delivery_failed"], agentId: "11111111-1111-4111-8111-111111111111" });

    expect(result.sources.map((source) => source.source)).toEqual(["delivery_failures"]);
    expect(deps.deliveryFailures?.longestWaiting).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ agentId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(deps.pendingApprovals.listPending).not.toHaveBeenCalled();
  });

  it("reports a failure read that threw as failed rather than as no failures", async () => {
    const deps = populated({ deliveryFailures: { longestWaiting: vi.fn(async () => { throw new Error("connection reset"); }) } });

    const result = await list(deps);

    expect(result.sources).toContainEqual({ source: "delivery_failures", status: "failed", total: null, included: 0 });
  });
});

/** A held reply as the owning reader ranks it: who waits and since when, never its draft. */
const heldReply = (overrides: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444",
  conversationId: "conversation-held",
  agentId: "11111111-1111-4111-8111-111111111111",
  holdReason: "draft_mode",
  createdAt: new Date("2026-08-26T05:45:00.000Z"),
  ...overrides,
});

/** The owning reader: the held replies waiting longest, up to the limit, and how many wait. */
const heldReplyQueue = (rows: Array<ReturnType<typeof heldReply>>, total = rows.length) => ({
  longestWaiting: vi.fn(async (_actor: unknown, query: { agentId?: string; limit: number }) => ({
    total,
    items: [...rows].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()).slice(0, query.limit),
  })),
});

describe("needs_attention held replies", () => {
  it("lists a held reply as an approval carrying its heldReplyId, ranked by wait with the routine decisions", async () => {
    const deps = populated({ heldReplies: heldReplyQueue([heldReply()]) });

    const result = await list(deps);

    expect(result.items.map((item) => [item.kind, item.conversationId])).toEqual([
      ["approval", "conversation-held"],
      ["approval", "conversation-approval"],
      ["handoff", "conversation-handoff"],
      ["negative_feedback", "conversation-quality"],
    ]);
    expect(result.items[0]).toEqual(expect.objectContaining({
      kind: "approval",
      title: "draft_mode",
      detail: null,
      since: "2026-08-26T05:45:00.000Z",
      agentId: "11111111-1111-4111-8111-111111111111",
      heldReplyId: "44444444-4444-4444-8444-444444444444",
      approvalHandle: null,
      dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=conversation-held",
    }));
    expect(result.sources).toContainEqual({ source: "approvals", status: "ok", total: 2, included: 2 });
  });

  it("leaves routine decisions as they were: the decision handle, and no held reply", async () => {
    const result = await list(populated({ heldReplies: heldReplyQueue([heldReply()]) }), { kinds: ["approval"] });

    expect(result.items[1]).toEqual(expect.objectContaining({
      conversationId: "conversation-approval",
      title: "Refund over limit",
      detail: null,
      approvalHandle: "decision-handle-1",
      heldReplyId: null,
    }));
  });

  it("reads only the longest-waiting held replies it lists as the signed-in teammate, scoped to the requested agent", async () => {
    const newest = heldReply({ id: "66666666-6666-4666-8666-666666666666", conversationId: "conversation-newest", createdAt: new Date("2026-08-26T09:00:00.000Z") });
    const oldest = heldReply({ conversationId: "conversation-oldest", createdAt: new Date("2026-08-26T01:00:00.000Z") });
    const deps = dependencies({ heldReplies: heldReplyQueue([newest, oldest], 100_000) });

    const result = await list(deps, { kinds: ["approval"], agentId: "11111111-1111-4111-8111-111111111111", limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({ conversationId: "conversation-oldest", heldReplyId: oldest.id })]);
    expect(result.sources).toEqual([{ source: "approvals", status: "ok", total: 100_000, included: 1 }]);
    expect(deps.heldReplies?.longestWaiting).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "workspace-1", accountId: "account-1", userId: "operator-1" },
      { agentId: "11111111-1111-4111-8111-111111111111", limit: 1 },
    );
  });

  it("reads held replies under the approvals source's conversation takeover permission", async () => {
    const deps = populated({ heldReplies: heldReplyQueue([heldReply()]) });

    const result = await list(deps, {}, context(new Set(["workspace.history.read", "workspace.quality.read"])));

    expect(result.items.map((item) => item.kind)).not.toContain("approval");
    expect(result.sources).toContainEqual({ source: "approvals", status: "unauthorized", total: null, included: 0 });
    expect(deps.heldReplies?.longestWaiting).not.toHaveBeenCalled();
  });

  it("reports the approvals as failed when the held replies cannot be read, rather than as routine decisions alone", async () => {
    const deps = populated({
      heldReplies: { longestWaiting: vi.fn(async () => { throw new Error("connection reset"); }) },
    });

    const result = await list(deps);

    expect(result.sources).toContainEqual({ source: "approvals", status: "failed", total: null, included: 0 });
  });
});
