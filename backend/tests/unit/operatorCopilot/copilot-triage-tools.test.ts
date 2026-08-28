import { describe, expect, it, vi } from "vitest";

import { createWorkspaceTriageCopilotTools } from "../../../src/modules/operatorCopilot/tools/triage.js";
import type { WorkspaceTriageCopilotToolDependencies } from "../../../src/modules/operatorCopilot/tools/triage.js";

const ALL_PERMISSIONS = new Set([
  "workspace.history.read",
  "workspace.conversation.takeover",
  "workspace.quality.read",
  "workspace.documents.read",
  "workspace.retrieval.query",
]);

const context = (permissions: ReadonlySet<string> = ALL_PERMISSIONS, agentId: string | null = null) => ({
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  permissions,
  currentAuthorization: {
    hasAllPermissions: async ({ requiredPermissions }: { requiredPermissions: readonly string[] }) =>
      requiredPermissions.every((permission) => permissions.has(permission)),
  },
  pageContext: { view: "activity" as const, agentId, conversationId: null, selection: null, entities: [] },
});

const conversation = (overrides: Partial<{
  id: string; agentId: string | null; preview: string | null; updatedAt: string;
  ownership: { state: string; ownerDisplayName: string | null; reason: string | null; takenOverAt: string | null; updatedAt: string };
}> = {}) => ({
  id: "conversation-1",
  agentId: "agent-1",
  agentName: "Support",
  preview: "Where is my refund?",
  createdAt: "2026-08-26T08:00:00.000Z",
  updatedAt: "2026-08-26T09:00:00.000Z",
  ownership: {
    state: "human_owned",
    ownerDisplayName: null,
    reason: "escalation",
    takenOverAt: null,
    updatedAt: "2026-08-26T09:00:00.000Z",
  },
  ...overrides,
});

const qualityTurn = (overrides: Record<string, unknown> = {}) => ({
  assistantMessageId: "message-1",
  conversationId: "conversation-9",
  agentId: "agent-1",
  agentName: "Support",
  question: "Do you ship to Spain?",
  answerPreview: "I could not find that.",
  createdAt: "2026-08-26T07:00:00.000Z",
  feedback: {
    downCount: 1,
    latestDownUpdatedAt: "2026-08-26T07:30:00.000Z",
    comments: [{ value: "down", comment: "This was wrong.", updatedAt: "2026-08-26T07:30:00.000Z" }],
  },
  ...overrides,
});

const dependencies = (overrides: Partial<WorkspaceTriageCopilotToolDependencies> = {}): WorkspaceTriageCopilotToolDependencies => ({
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
  documentStatusService: {
    summarizeWorkspace: vi.fn(async () => ({ documentCount: 0, readyDocumentCount: 0, pendingDocumentCount: 0, failedDocumentCount: 0 })),
    listByStatuses: vi.fn(async () => []),
  },
  documentSourceStatusService: { summarizeSourcesForWorkspace: vi.fn(async () => ({ sources: [], documentsWithoutSourceCount: 0 })) },
  evalResultsService: { listWithLatestRun: vi.fn(async () => []) },
  workspaceRouteKeyResolver: { resolveWorkspaceKey: vi.fn(async () => "acme") },
  ...overrides,
} as WorkspaceTriageCopilotToolDependencies);

const digest = async (deps: WorkspaceTriageCopilotToolDependencies, invocation = context()) => {
  const [descriptor] = createWorkspaceTriageCopilotTools(deps);
  return descriptor!.createTool(invocation).invoke({}, {} as never);
};

describe("workspace_triage", () => {
  it("declares one read that every operator role can reach", () => {
    const [descriptor] = createWorkspaceTriageCopilotTools(dependencies());

    expect(descriptor).toMatchObject({
      name: "workspace_triage",
      shape: "read",
      contributingModule: "operatorCopilot",
      // Members hold no quality permission, so requiring the union would take the digest away from
      // exactly the operators whose session it is meant to orient.
      requiredPermissions: ["workspace.history.read"],
      dashboardSubject: { type: "needs_attention" },
    });
  });

  it("puts the longest wait at the top and ranks escalations above failures and backlog", async () => {
    const result = await digest(dependencies({
      pendingApprovals: {
        listPending: vi.fn(async () => [
          { conversationId: "conversation-approval", agentId: "agent-1", reason: "Refund over limit", createdAt: new Date("2026-08-26T06:00:00.000Z") },
        ]),
      },
      chatHistoryService: {
        getConversation: vi.fn(),
        getConversationTurn: vi.fn(),
        listConversations: vi.fn(async () => ({
          conversations: [
            conversation({ id: "conversation-recent", ownership: { state: "human_owned", ownerDisplayName: null, reason: null, takenOverAt: null, updatedAt: "2026-08-26T09:00:00.000Z" } }),
            conversation({ id: "conversation-stale", ownership: { state: "human_owned", ownerDisplayName: null, reason: null, takenOverAt: null, updatedAt: "2026-08-26T05:00:00.000Z" } }),
          ],
          total: 2,
        })),
      },
      qualitySignalsService: {
        getQualityStats: vi.fn(async () => ({ backlog: { grounding_gaps: 4, negative_feedback: 9 } })),
        listLowQualityTurns: vi.fn(async () => ({ items: [qualityTurn()], total: 1 })),
      },
    }));

    expect(result.items.map((item) => [item.kind, item.conversationId ?? item.title])).toEqual([
      ["handoff", "conversation-stale"],
      ["approval", "conversation-approval"],
      ["handoff", "conversation-recent"],
      ["negative_feedback", "conversation-9"],
      ["untriaged_quality_turns", "negative_feedback"],
      ["untriaged_quality_turns", "grounding_gaps"],
    ]);
    expect(result.items.map((item) => item.urgency)).toEqual([
      "blocking", "blocking", "blocking", "attention", "backlog", "backlog",
    ]);
  });

  it("ranks waiting handoffs over a window wider than the lines it lists", async () => {
    const listConversations = vi.fn(async () => ({ conversations: [], total: 0 }));
    await digest(dependencies({
      chatHistoryService: { getConversation: vi.fn(), getConversationTurn: vi.fn(), listConversations },
    }));

    // Ranking one page of ten would return the ten most recently active handoffs and call the
    // oldest of those the longest wait, which is the inversion #936 fixed for the dashboard.
    expect(listConversations).toHaveBeenCalledWith("workspace-1", { limit: 100, ownership: "human_owned" });
  });

  it("reports a source that could not be read as failed rather than as zero", async () => {
    const result = await digest(dependencies({
      documentStatusService: {
        summarizeWorkspace: vi.fn(async () => { throw new Error("connection refused"); }),
        listByStatuses: vi.fn(async () => []),
      },
    }));

    expect(result.sources).toContainEqual({ source: "documents", status: "failed", total: null, included: 0 });
    expect(result.sources.every((source) => source.status === "failed" || source.status === "ok")).toBe(true);
  });

  it("logs the source it could not read so a swallowed failure stays traceable", async () => {
    const warn = vi.fn();
    await digest(dependencies({
      logger: { warn },
      evalResultsService: { listWithLatestRun: vi.fn(async () => { throw new Error("statement timeout"); }) },
    }));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", source: "evals" }),
      expect.any(String),
    );
  });

  it("states a source the operator may not read instead of leaving the section out", async () => {
    const listPending = vi.fn(async () => []);
    const result = await digest(
      dependencies({ pendingApprovals: { listPending } }),
      context(new Set(["workspace.history.read"])),
    );

    expect(listPending).not.toHaveBeenCalled();
    expect(result.sources).toEqual([
      { source: "approvals", status: "unauthorized", total: null, included: 0 },
      { source: "handoffs", status: "ok", total: 0, included: 0 },
      { source: "quality", status: "unauthorized", total: null, included: 0 },
      { source: "documents", status: "unauthorized", total: null, included: 0 },
      { source: "document_sources", status: "unauthorized", total: null, included: 0 },
      { source: "evals", status: "unauthorized", total: null, included: 0 },
    ]);
  });

  it("reauthorizes each source instead of trusting the turn-start permission snapshot", async () => {
    const listPending = vi.fn(async () => []);
    const result = await digest(
      dependencies({ pendingApprovals: { listPending } }),
      {
        ...context(ALL_PERMISSIONS),
        currentAuthorization: {
          hasAllPermissions: vi.fn(async ({ requiredPermissions }: { requiredPermissions: ReadonlyArray<string> }) =>
            requiredPermissions[0] !== "workspace.conversation.takeover"),
        },
      },
    );

    expect(listPending).not.toHaveBeenCalled();
    expect(result.sources).toContainEqual({ source: "approvals", status: "unauthorized", total: null, included: 0 });
    expect(result.sources).toContainEqual({ source: "handoffs", status: "ok", total: 0, included: 0 });
  });

  it("drops a review line for a conversation an operator is already being asked to act on", async () => {
    const result = await digest(dependencies({
      pendingApprovals: {
        listPending: vi.fn(async () => [
          { conversationId: "conversation-9", agentId: "agent-1", reason: "Refund over limit", createdAt: new Date("2026-08-26T06:00:00.000Z") },
        ]),
      },
      qualitySignalsService: {
        getQualityStats: vi.fn(async () => ({ backlog: {} })),
        listLowQualityTurns: vi.fn(async () => ({ items: [qualityTurn()], total: 1 })),
      },
    }));

    expect(result.items.map((item) => item.kind)).toEqual(["approval"]);
    // The row was matched and then deliberately not listed; the source says both.
    expect(result.sources).toContainEqual({ source: "quality", status: "ok", total: 1, included: 0 });
  });

  it("reports the rows a capped source matched next to the lines it listed", async () => {
    const result = await digest(dependencies({
      evalResultsService: {
        listWithLatestRun: vi.fn(async () => Array.from({ length: 14 }, (_unused, index) => ({
          id: `case-${index}`,
          name: `Case ${index}`,
          status: "failing" as const,
          updatedAt: "2026-08-20T10:00:00.000Z",
          agent: { agentId: "agent-1", name: "Support" },
          latestRun: { startedAt: `2026-08-2${index % 9}T10:00:00.000Z`, completedAt: null },
        }))),
      },
    }));

    expect(result.sources).toContainEqual({ source: "evals", status: "ok", total: 14, included: 10 });
  });

  it("leaves passing eval cases out and links each failing one to its case", async () => {
    const result = await digest(dependencies({
      evalResultsService: {
        listWithLatestRun: vi.fn(async () => [
          { id: "case-pass", name: "Passing", status: "passing" as const, updatedAt: "2026-08-20T10:00:00.000Z", agent: { agentId: "agent-1", name: "Support" }, latestRun: null },
          { id: "case-fail", name: "Failing", status: "failing" as const, updatedAt: "2026-08-20T10:00:00.000Z", agent: { agentId: "agent-1", name: "Support" }, latestRun: null },
        ]),
      },
    }));

    expect(result.items).toEqual([expect.objectContaining({
      kind: "failing_eval_case",
      title: "Failing",
      dashboardUrl: "/w/acme/eval/case-fail",
    })]);
  });

  it("gives every line a dashboard link for its own subject", async () => {
    const result = await digest(dependencies({
      pendingApprovals: {
        listPending: vi.fn(async () => [
          { conversationId: "conversation-approval", agentId: "agent-1", reason: null, createdAt: new Date("2026-08-26T06:00:00.000Z") },
        ]),
      },
      documentStatusService: {
        summarizeWorkspace: vi.fn(async () => ({ documentCount: 3, readyDocumentCount: 1, pendingDocumentCount: 1, failedDocumentCount: 1 })),
        listByStatuses: vi.fn(async () => [
          { id: "document-1", title: "Returns policy", status: "failed", failureReason: "unsupported encoding", updatedAt: new Date("2026-08-26T04:00:00.000Z"), sourceId: null },
        ]),
      },
      documentSourceStatusService: {
        summarizeSourcesForWorkspace: vi.fn(async () => ({ sources: [
          { id: "source-1", kind: "website", name: "Help centre", lastSyncStatus: "failure", lastSyncedAt: new Date("2026-08-26T03:00:00.000Z"), documentCount: 12 },
          { id: "source-2", kind: "website", name: "Blog", lastSyncStatus: "success", lastSyncedAt: new Date("2026-08-26T03:00:00.000Z"), documentCount: 4 },
        ], documentsWithoutSourceCount: 0 })),
      },
    }));

    expect(result.items.map((item) => [item.kind, item.dashboardUrl])).toEqual([
      ["approval", "/w/acme/activity?itemKind=chat&itemId=conversation-approval"],
      ["failed_document", "/w/acme/knowledge/documents/document-1"],
      ["failed_source_sync", "/w/acme/knowledge"],
      ["documents_processing", "/w/acme/knowledge"],
    ]);
    // The processing line stands for a group, so it is listed without counting as a matched row.
    expect(result.sources).toContainEqual({ source: "documents", status: "ok", total: 1, included: 1 });
    // A sync status that is neither a recorded success nor absent surfaces rather than hides.
    expect(result.sources).toContainEqual({ source: "document_sources", status: "ok", total: 1, included: 1 });
  });

  it("narrows every agent-scoped source to the requested agent and keeps the shared knowledge base", async () => {
    const getQualityStats = vi.fn(async () => ({ backlog: {} }));
    const listLowQualityTurns = vi.fn(async () => ({ items: [], total: 0 }));
    const deps = dependencies({
      qualitySignalsService: { getQualityStats, listLowQualityTurns },
      pendingApprovals: {
        listPending: vi.fn(async () => [
          { conversationId: "conversation-other", agentId: "agent-2", reason: "Other agent", createdAt: new Date("2026-08-26T06:00:00.000Z") },
        ]),
      },
      documentStatusService: {
        summarizeWorkspace: vi.fn(async () => ({ documentCount: 1, readyDocumentCount: 0, pendingDocumentCount: 0, failedDocumentCount: 1 })),
        listByStatuses: vi.fn(async () => [
          { id: "document-1", title: "Returns policy", status: "failed", failureReason: null, updatedAt: new Date("2026-08-26T04:00:00.000Z"), sourceId: null },
        ]),
      },
    });
    const [descriptor] = createWorkspaceTriageCopilotTools(deps);

    const result = await descriptor!.createTool(context(ALL_PERMISSIONS)).invoke({ agentId: "agent-1" }, {} as never);

    expect(getQualityStats).toHaveBeenCalledWith("workspace-1", { range: "30d", agentId: "agent-1" });
    expect(listLowQualityTurns).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ agentId: "agent-1" }));
    expect(result.items.map((item) => item.kind)).toEqual(["failed_document"]);
    expect(result.sources).toContainEqual({ source: "approvals", status: "ok", total: 0, included: 0 });
  });

  it("holds every source to its own cap when several overflow at once", async () => {
    const overflowing = <T,>(build: (index: number) => T) => Array.from({ length: 25 }, (_unused, index) => build(index));
    const result = await digest(dependencies({
      pendingApprovals: {
        listPending: vi.fn(async () => overflowing((index) => ({
          conversationId: `conversation-approval-${index}`,
          agentId: "agent-1",
          reason: `Approval ${index}`,
          createdAt: new Date(`2026-08-26T06:${String(index).padStart(2, "0")}:00.000Z`),
        }))),
      },
      documentStatusService: {
        summarizeWorkspace: vi.fn(async () => ({ documentCount: 60, readyDocumentCount: 0, pendingDocumentCount: 5, failedDocumentCount: 25 })),
        // The repository honours the limit; the tool must not rely on that alone.
        listByStatuses: vi.fn(async () => overflowing((index) => ({
          id: `document-${index}`,
          title: `Document ${index}`,
          status: "failed",
          failureReason: null,
          updatedAt: new Date(`2026-08-26T04:${String(index).padStart(2, "0")}:00.000Z`),
          sourceId: null,
        }))),
      },
      documentSourceStatusService: {
        summarizeSourcesForWorkspace: vi.fn(async () => ({ sources: overflowing((index) => ({
          id: `source-${index}`,
          kind: "website",
          name: `Source ${index}`,
          lastSyncStatus: "failure",
          lastSyncedAt: new Date(`2026-08-26T03:${String(index).padStart(2, "0")}:00.000Z`),
          documentCount: 1,
        })), documentsWithoutSourceCount: 0 })),
      },
    }));

    // Documents and their sources read the same permission, and sharing one cap would let the
    // recent document failures bury the broken syncs that explain them.
    for (const source of result.sources) {
      expect(source.included).toBeLessThanOrEqual(10);
    }
    expect(result.sources).toContainEqual({ source: "documents", status: "ok", total: 25, included: 10 });
    expect(result.sources).toContainEqual({ source: "document_sources", status: "ok", total: 25, included: 10 });
    expect(result.items.filter((item) => item.kind === "failed_source_sync")).toHaveLength(10);
  });

  it("counts an aggregate line as listed without counting it as a matched row", async () => {
    const result = await digest(dependencies({
      qualitySignalsService: {
        getQualityStats: vi.fn(async () => ({ backlog: { grounding_gaps: 12 } })),
        listLowQualityTurns: vi.fn(async () => ({ items: [], total: 0 })),
      },
    }));

    expect(result.items).toEqual([expect.objectContaining({ kind: "untriaged_quality_turns", count: 12 })]);
    expect(result.sources).toContainEqual({ source: "quality", status: "ok", total: 0, included: 0 });
  });

  it("answers for the whole workspace even when one agent is on screen", async () => {
    const getQualityStats = vi.fn(async () => ({ backlog: {} }));
    const listPending = vi.fn(async () => [
      { conversationId: "conversation-other", agentId: "agent-2", reason: "Other agent", createdAt: new Date("2026-08-26T06:00:00.000Z") },
    ]);
    const result = await digest(
      dependencies({ qualitySignalsService: { getQualityStats, listLowQualityTurns: vi.fn(async () => ({ items: [], total: 0 })) }, pendingApprovals: { listPending } }),
      context(ALL_PERMISSIONS, "agent-1"),
    );

    expect(getQualityStats).toHaveBeenCalledWith("workspace-1", { range: "30d" });
    expect(result.items.map((item) => item.agentId)).toEqual(["agent-2"]);
  });

  it("marks an unassigned handoff apart from one an operator already owns", async () => {
    const result = await digest(dependencies({
      chatHistoryService: {
        getConversation: vi.fn(),
        getConversationTurn: vi.fn(),
        listConversations: vi.fn(async () => ({
          conversations: [
            conversation({ id: "conversation-owned", ownership: { state: "human_owned", ownerDisplayName: "Ada", reason: null, takenOverAt: "2026-08-26T09:05:00.000Z", updatedAt: "2026-08-26T09:05:00.000Z" } }),
            conversation({ id: "conversation-waiting" }),
          ],
          total: 2,
        })),
      },
    }));

    expect(result.items.map((item) => [item.conversationId, item.detail])).toEqual([
      ["conversation-waiting", null],
      ["conversation-owned", "Ada"],
    ]);
  });
});
