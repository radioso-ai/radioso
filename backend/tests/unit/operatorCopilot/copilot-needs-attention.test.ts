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

const deliveryFailurePages = (...pages: Array<Array<ReturnType<typeof deliveryFailure>>>) => {
  const listOpen = vi.fn(async (_workspaceId: string, query: { cursor?: string }) => {
    const index = query.cursor === undefined ? 0 : Number(query.cursor);
    return { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
  });
  return { listOpen };
};

const dependencies = (overrides: Partial<NeedsAttentionCopilotToolDependencies> = {}): NeedsAttentionCopilotToolDependencies => ({
  pendingApprovals: { listPending: vi.fn(async () => []) },
  deliveryFailures: deliveryFailurePages([]),
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
    const deps = populated({ deliveryFailures: deliveryFailurePages([deliveryFailure()]) });

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
    const deps = populated({ deliveryFailures: deliveryFailurePages([deliveryFailure()]) });

    const result = await list(deps, {}, context(new Set(["workspace.history.read", "workspace.quality.read"])));

    expect(result.items.map((item) => item.kind)).not.toContain("delivery_failed");
    expect(result.sources).toContainEqual({ source: "delivery_failures", status: "unauthorized", total: null, included: 0 });
    expect(deps.deliveryFailures?.listOpen).not.toHaveBeenCalled();
  });

  it("reads every page, because the reader is newest first and the longest wait is on its last page", async () => {
    const newest = deliveryFailure({ conversationId: "conversation-newest", openedAt: new Date("2026-08-26T09:00:00.000Z") });
    const oldest = deliveryFailure({ conversationId: "conversation-oldest", kind: "halted", detailCode: null, openedAt: new Date("2026-08-26T01:00:00.000Z") });
    const deps = dependencies({ deliveryFailures: deliveryFailurePages([newest], [oldest]) });

    const result = await list(deps, { kinds: ["delivery_failed"], limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({ conversationId: "conversation-oldest", title: "halted", detail: null })]);
    expect(result.sources).toEqual([{ source: "delivery_failures", status: "ok", total: 2, included: 1 }]);
    expect(deps.deliveryFailures?.listOpen).toHaveBeenNthCalledWith(2, "workspace-1", expect.objectContaining({ cursor: "1" }));
  });

  it("scopes the failures to the requested agent and reads no other source when asked for this kind alone", async () => {
    const deps = populated({ deliveryFailures: deliveryFailurePages([deliveryFailure()]) });

    const result = await list(deps, { kinds: ["delivery_failed"], agentId: "11111111-1111-4111-8111-111111111111" });

    expect(result.sources.map((source) => source.source)).toEqual(["delivery_failures"]);
    expect(deps.deliveryFailures?.listOpen).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ agentId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(deps.pendingApprovals.listPending).not.toHaveBeenCalled();
  });

  it("reports a failure read that threw as failed rather than as no failures", async () => {
    const deps = populated({ deliveryFailures: { listOpen: vi.fn(async () => { throw new Error("connection reset"); }) } });

    const result = await list(deps);

    expect(result.sources).toContainEqual({ source: "delivery_failures", status: "failed", total: null, included: 0 });
  });
});

const heldReply = (overrides: Record<string, unknown> = {}) => ({
  id: "44444444-4444-4444-8444-444444444444",
  conversationId: "conversation-held",
  agentId: "11111111-1111-4111-8111-111111111111",
  state: "pending" as const,
  holdReason: "draft_mode",
  facts: { outcome: "answered", grounding: "grounded", coverage: "answered", handoff: { requested: false, reason: null } },
  dependsOnSuppressedAction: false,
  suppressedEffects: [],
  draftText: "Your refund was issued on Monday.",
  editedText: null,
  answersMessageId: "55555555-5555-4555-8555-555555555555",
  releasedMessageId: null,
  createdAt: new Date("2026-08-26T05:45:00.000Z"),
  decidedAt: null,
  releaserUserId: null,
  editorUserId: null,
  discardedByUserId: null,
  supersededReason: null,
  attentionOpen: true,
  ...overrides,
});

const heldReplyPages = (...pages: Array<Array<ReturnType<typeof heldReply>>>) => ({
  list: vi.fn(async (_actor: unknown, query: { cursor?: string }) => {
    const index = query.cursor === undefined ? 0 : Number(query.cursor);
    return { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null };
  }),
  current: vi.fn(async () => ({ heldReply: null })),
});

describe("needs_attention held replies", () => {
  it("lists a held reply as an approval carrying its heldReplyId, ranked by wait with the routine decisions", async () => {
    const deps = populated({ heldReplies: heldReplyPages([heldReply()]) });

    const result = await list(deps);

    expect(result.items.map((item) => [item.kind, item.conversationId])).toEqual([
      ["approval", "conversation-held"],
      ["approval", "conversation-approval"],
      ["handoff", "conversation-handoff"],
      ["negative_feedback", "conversation-quality"],
    ]);
    expect(result.items[0]).toEqual(expect.objectContaining({
      kind: "approval",
      title: "Your refund was issued on Monday.",
      detail: "draft_mode",
      since: "2026-08-26T05:45:00.000Z",
      agentId: "11111111-1111-4111-8111-111111111111",
      heldReplyId: "44444444-4444-4444-8444-444444444444",
      approvalHandle: null,
      dashboardUrl: "/w/acme/activity?itemKind=chat&itemId=conversation-held",
    }));
    expect(result.sources).toContainEqual({ source: "approvals", status: "ok", total: 2, included: 2 });
  });

  it("leaves routine decisions as they were: the decision handle, and no held reply", async () => {
    const result = await list(populated({ heldReplies: heldReplyPages([heldReply()]) }), { kinds: ["approval"] });

    expect(result.items[1]).toEqual(expect.objectContaining({
      conversationId: "conversation-approval",
      title: "Refund over limit",
      detail: null,
      approvalHandle: "decision-handle-1",
      heldReplyId: null,
    }));
  });

  it("reads every page of open held replies as the signed-in teammate, scoped to the requested agent", async () => {
    const newest = heldReply({ id: "66666666-6666-4666-8666-666666666666", conversationId: "conversation-newest", createdAt: new Date("2026-08-26T09:00:00.000Z") });
    const oldest = heldReply({ conversationId: "conversation-oldest", createdAt: new Date("2026-08-26T01:00:00.000Z") });
    const deps = dependencies({ heldReplies: heldReplyPages([newest], [oldest]) });

    const result = await list(deps, { kinds: ["approval"], agentId: "11111111-1111-4111-8111-111111111111", limit: 1 });

    expect(result.items).toEqual([expect.objectContaining({ conversationId: "conversation-oldest", heldReplyId: oldest.id })]);
    expect(result.sources).toEqual([{ source: "approvals", status: "ok", total: 2, included: 1 }]);
    expect(deps.heldReplies?.list).toHaveBeenNthCalledWith(
      1,
      { workspaceId: "workspace-1", accountId: "account-1", userId: "operator-1" },
      expect.objectContaining({ attention: "open", agentId: "11111111-1111-4111-8111-111111111111" }),
    );
    expect(deps.heldReplies?.list).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ cursor: "1" }));
  });

  it("reads held replies under the approvals source's conversation takeover permission", async () => {
    const deps = populated({ heldReplies: heldReplyPages([heldReply()]) });

    const result = await list(deps, {}, context(new Set(["workspace.history.read", "workspace.quality.read"])));

    expect(result.items.map((item) => item.kind)).not.toContain("approval");
    expect(result.sources).toContainEqual({ source: "approvals", status: "unauthorized", total: null, included: 0 });
    expect(deps.heldReplies?.list).not.toHaveBeenCalled();
  });

  it("reports the approvals as failed when the held replies cannot be read, rather than as routine decisions alone", async () => {
    const deps = populated({
      heldReplies: { list: vi.fn(async () => { throw new Error("connection reset"); }), current: vi.fn(async () => ({ heldReply: null })) },
    });

    const result = await list(deps);

    expect(result.sources).toContainEqual({ source: "approvals", status: "failed", total: null, included: 0 });
  });
});
