import { z } from "zod";

import type { CopilotToolDescriptor, CopilotToolInvocationContext, CopilotWorkspaceRouteKeyResolver } from "../contracts.js";
import type { CopilotEvalResultsPort } from "../contracts/evalCases.js";
import { buildCopilotDashboardLink } from "../dashboardLinks.js";
import {
  clip,
  escalatedAt,
  latestDownComment,
  readAuthorizedSource,
  HANDOFF_RANKING_WINDOW,
  MAX_DETAIL_CHARS,
  MAX_TITLE_CHARS,
  type AuthorizedSourceRead,
  type CopilotPendingApprovalsPort,
  type CopilotTriageLogPort,
} from "./escalationSources.js";
import {
  buildCopilotTriageDigest,
  copilotTriageSourceForKind,
  copilotTriageWaitingMinutes,
  isCopilotTriageAggregate,
  type CopilotTriageItem,
  type CopilotTriageSourceId,
} from "../triageDigest.js";
import type { CopilotConversationHistoryPort } from "./chat.js";
import type { CopilotDocumentSourceStatusPort, CopilotDocumentStatusPort } from "./documents.js";
import type { CopilotQualitySignalsPort } from "./quality.js";
import { describeNamedAgent, entity, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);

/**
 * How many lines one source may contribute. The cap is the point of a digest, so every capped
 * source reports the rows it matched next to the lines it listed.
 */
const MAX_ITEMS_PER_SOURCE = 10;
/**
 * The one status the ingestion writer records for a healthy sync. Anything else — including a
 * status a connector added later — surfaces as a failing source, because an unrecognized status
 * that reads as healthy is the failure this section exists to catch.
 */
const SUCCESSFUL_SYNC_STATUS = "success";

export interface WorkspaceTriageCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly pendingApprovals: CopilotPendingApprovalsPort;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly documentStatusService: CopilotDocumentStatusPort;
  readonly documentSourceStatusService: CopilotDocumentSourceStatusPort;
  readonly evalResultsService: CopilotEvalResultsPort;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger?: CopilotTriageLogPort;
}

const triageInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
}).strict();

const triageOutputSchema = z.object({
  items: z.array(z.object({
    kind: z.enum([
      "approval",
      "handoff",
      "negative_feedback",
      "failed_document",
      "failed_source_sync",
      "failing_eval_case",
      "untriaged_quality_turns",
      "documents_processing",
    ]),
    urgency: z.enum(["blocking", "attention", "backlog"]),
    /** Workspace data, never composed copy: a reason, preview, name, or signal id, or null. */
    title: z.string().nullable(),
    detail: z.string().nullable(),
    since: z.string().nullable(),
    waitingMinutes: z.number().int().nonnegative().nullable(),
    count: z.number().int().positive(),
    agentId: z.string().nullable(),
    conversationId: z.string().nullable(),
    dashboardUrl: z.string().startsWith("/"),
  }).strict()),
  sources: z.array(z.object({
    source: z.enum(["approvals", "handoffs", "quality", "documents", "document_sources", "evals"]),
    status: z.enum(["ok", "unauthorized", "failed"]),
    total: z.number().int().nonnegative().nullable(),
    included: z.number().int().nonnegative(),
  }).strict()),
}).strict();

type WorkspaceTriageInput = z.infer<typeof triageInputSchema>;
type WorkspaceTriageOutput = z.infer<typeof triageOutputSchema>;

const description = "Read one ranked digest of what needs the operator's attention: waiting handoffs and approvals first, then failures and written complaints, then untriaged backlog counts. Every line carries a dashboard link. Sources report whether they were read: a source marked unauthorized or failed is unknown, never zero. The knowledge base is workspace-wide, so its lines stay in the digest even when the request names one agent. This is the answer to a broad opening question about the workspace; needs_attention lists the same escalations as a working queue when the operator is about to act on one.";

export const createWorkspaceTriageCopilotTools = (
  deps: WorkspaceTriageCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<WorkspaceTriageInput, WorkspaceTriageOutput>> => [{
  name: "workspace_triage",
  shape: "read",
  verificationCost: () => 0,
  uiLabel: "Checking what needs attention",
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "needs_attention" },
  requiredPermissions: ["workspace.history.read"],
  description,
  inputSchema: triageInputSchema,
  outputSchema: triageOutputSchema,
  createTool: (context) => ({
    name: "workspace_triage",
    description,
    inputSchema: triageInputSchema,
    outputSchema: triageOutputSchema,
    // Scoping comes from the request alone. The other agent-aware readers fall back to the agent on
    // screen, which is right when the question is about that agent; here it would answer "what
    // needs my attention" with one agent's share of it because the operator happened to be on its
    // page, and the omission would be invisible in the result.
    invoke: async (input) => buildDigest(deps, context, input.agentId ?? null),
  }),
  describeEntity: (input, context) => input.agentName
    ? describeNamedAgent(input, context, deps.agentLookup)
    : entity("agent", input.agentId),
}];

type SourceResult = AuthorizedSourceRead<CopilotTriageItem>;

const buildDigest = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  context: CopilotToolInvocationContext,
  agentId: string | null,
): Promise<WorkspaceTriageOutput> => {
  const now = new Date();
  // A digest is many results in one call, and the catalog boundary links one subject per result.
  // Resolving the key here is what lets every line carry its own handoff.
  const [workspaceKey, ...sources] = await Promise.all([
    deps.workspaceRouteKeyResolver.resolveWorkspaceKey(context.workspaceId),
    readAuthorizedSource(deps, context, "approvals", () => readApprovals(deps, context.workspaceId, agentId)),
    readAuthorizedSource(deps, context, "handoffs", () => readHandoffs(deps, context.workspaceId, agentId)),
    readAuthorizedSource(deps, context, "quality", () => readQuality(deps, context.workspaceId, agentId)),
    readAuthorizedSource(deps, context, "documents", () => readDocuments(deps, context.workspaceId)),
    readAuthorizedSource(deps, context, "document_sources", () => readDocumentSources(deps, context.workspaceId)),
    readAuthorizedSource(deps, context, "evals", () => readEvalCases(deps, context.workspaceId, agentId)),
  ]);

  const ranked = buildCopilotTriageDigest(sources.flatMap((source) => source.items));
  const includedBySource = ranked
    .filter((item) => !isCopilotTriageAggregate(item.kind))
    .reduce((counts, item) => {
      const source = copilotTriageSourceForKind(item.kind);
      return { ...counts, [source]: (counts[source] ?? 0) + 1 };
    }, {} as Partial<Record<CopilotTriageSourceId, number>>);

  return {
    items: ranked.map((item) => ({
      kind: item.kind,
      urgency: item.urgency,
      title: clip(item.title, MAX_TITLE_CHARS),
      detail: clip(item.detail, MAX_DETAIL_CHARS),
      since: item.since,
      waitingMinutes: copilotTriageWaitingMinutes(item.since, now),
      count: item.count,
      agentId: item.agentId,
      conversationId: item.conversationId,
      dashboardUrl: buildCopilotDashboardLink(workspaceKey, item.subject),
    })),
    sources: sources.map(({ report }) => ({ ...report, included: includedBySource[report.source] ?? 0 })),
  };
};

const readApprovals = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
): Promise<SourceResult> => {
  const pending = (await deps.pendingApprovals.listPending(workspaceId))
    .filter((decision) => agentId === null || decision.agentId === agentId);
  return {
    total: pending.length,
    items: pending
      .slice()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, MAX_ITEMS_PER_SOURCE)
      .map((decision) => ({
        kind: "approval" as const,
        urgency: "blocking" as const,
        title: decision.reason,
        detail: null,
        since: decision.createdAt.toISOString(),
        count: 1,
        agentId: decision.agentId,
        conversationId: decision.conversationId,
        subject: { type: "conversation", id: decision.conversationId },
      })),
  };
};

const readHandoffs = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
): Promise<SourceResult> => {
  const page = await deps.chatHistoryService.listConversations(workspaceId, {
    limit: HANDOFF_RANKING_WINDOW,
    ownership: "human_owned",
  });
  const waiting = page.conversations
    .filter((conversation) => conversation.ownership !== undefined)
    .filter((conversation) => agentId === null || conversation.agentId === agentId);
  return {
    // The page total counts every human-owned conversation, not just the window that was ranked,
    // so a workspace with more waiting handoffs than the window says so. Scoped to one agent it
    // counts what the window held, because the underlying total is not agent-aware.
    total: agentId === null ? page.total : waiting.length,
    items: waiting
      .slice()
      .sort((left, right) => escalatedAt(left).localeCompare(escalatedAt(right)))
      .slice(0, MAX_ITEMS_PER_SOURCE)
      .map((conversation) => ({
        kind: "handoff" as const,
        urgency: "blocking" as const,
        title: conversation.preview,
        // Null means nobody has taken the conversation over, which is the more urgent handoff.
        detail: conversation.ownership?.takenOverAt ? conversation.ownership.ownerDisplayName : null,
        since: escalatedAt(conversation),
        count: 1,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        subject: { type: "conversation", id: conversation.id },
      })),
  };
};

const readQuality = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
): Promise<SourceResult> => {
  const agentScope = agentId === null ? {} : { agentId };
  const [stats, feedback] = await Promise.all([
    deps.qualitySignalsService.getQualityStats(workspaceId, { range: "30d", ...agentScope }),
    deps.qualitySignalsService.listLowQualityTurns(workspaceId, {
      limit: MAX_ITEMS_PER_SOURCE,
      ...agentScope,
      feedbackValues: ["down"],
      hasComment: true,
      activeNegativeFeedbackOnly: true,
      sort: "negative_feedback_updated_at",
    }),
  ]);

  const backlog = Object.entries(stats.backlog)
    .filter(([, count]) => count > 0)
    .map(([signal, count]) => ({
      kind: "untriaged_quality_turns" as const,
      urgency: "backlog" as const,
      title: signal,
      detail: null,
      since: null,
      count,
      agentId,
      conversationId: null,
      subject: { type: "quality_turn" },
    }));

  return {
    total: feedback.total,
    items: [
      ...feedback.items.map((turn) => ({
        kind: "negative_feedback" as const,
        urgency: "attention" as const,
        title: turn.question,
        detail: latestDownComment(turn.feedback.comments),
        since: turn.feedback.latestDownUpdatedAt ?? turn.createdAt,
        count: 1,
        agentId: turn.agentId,
        conversationId: turn.conversationId,
        subject: { type: "conversation", id: turn.conversationId },
      })),
      ...backlog,
    ],
  };
};

const readDocuments = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
): Promise<SourceResult> => {
  const [summary, failed] = await Promise.all([
    deps.documentStatusService.summarizeWorkspace(workspaceId),
    deps.documentStatusService.listByStatuses(workspaceId, ["failed"], { limit: MAX_ITEMS_PER_SOURCE }),
  ]);

  return {
    total: summary.failedDocumentCount,
    items: [
      ...failed.slice(0, MAX_ITEMS_PER_SOURCE).map((document) => ({
        kind: "failed_document" as const,
        urgency: "attention" as const,
        title: document.title,
        detail: document.failureReason ?? null,
        since: document.updatedAt.toISOString(),
        count: 1,
        agentId: null,
        conversationId: null,
        subject: { type: "document", id: document.id },
      })),
      ...(summary.pendingDocumentCount > 0 ? [{
        kind: "documents_processing" as const,
        urgency: "backlog" as const,
        title: null,
        detail: null,
        since: null,
        count: summary.pendingDocumentCount,
        agentId: null,
        conversationId: null,
        subject: { type: "document" },
      }] : []),
    ],
  };
};

const readDocumentSources = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
): Promise<SourceResult> => {
  const failing = (await deps.documentSourceStatusService.summarizeSourcesForWorkspace(workspaceId)).sources
    .filter((source) => source.lastSyncStatus !== null && source.lastSyncStatus !== SUCCESSFUL_SYNC_STATUS);

  return {
    total: failing.length,
    items: failing.slice(0, MAX_ITEMS_PER_SOURCE).map((source) => ({
      kind: "failed_source_sync" as const,
      urgency: "attention" as const,
      title: source.name,
      detail: source.lastSyncStatus,
      since: source.lastSyncedAt ? source.lastSyncedAt.toISOString() : null,
      count: 1,
      agentId: null,
      conversationId: null,
      subject: { type: "document" },
    })),
  };
};

const readEvalCases = async (
  deps: WorkspaceTriageCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
): Promise<SourceResult> => {
  const failing = (await deps.evalResultsService.listWithLatestRun(workspaceId))
    .filter((evalCase) => evalCase.status === "failing" || evalCase.status === "error")
    .filter((evalCase) => agentId === null || evalCase.agent.agentId === agentId);
  return {
    total: failing.length,
    items: failing
      .slice()
      .sort((left, right) => lastRunAt(right).localeCompare(lastRunAt(left)))
      .slice(0, MAX_ITEMS_PER_SOURCE)
      .map((evalCase) => ({
        kind: "failing_eval_case" as const,
        urgency: "attention" as const,
        title: evalCase.name,
        detail: evalCase.status,
        since: evalCase.latestRun ? lastRunAt(evalCase) : null,
        count: 1,
        agentId: evalCase.agent.agentId,
        conversationId: null,
        subject: { type: "eval", id: evalCase.id },
      })),
  };
};

const lastRunAt = (evalCase: { readonly latestRun: { readonly startedAt: string; readonly completedAt: string | null } | null; readonly updatedAt: string }): string =>
  evalCase.latestRun?.completedAt ?? evalCase.latestRun?.startedAt ?? evalCase.updatedAt;
