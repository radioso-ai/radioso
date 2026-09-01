import { z } from "zod";

import type { CopilotEntityReference, CopilotToolDescriptor, CopilotToolInvocationContext, CopilotWorkspaceRouteKeyResolver } from "../contracts.js";
import { buildCopilotDashboardLink } from "../dashboardLinks.js";
import { copilotTriageWaitingMinutes } from "../triageDigest.js";
import type { CopilotConversationHistoryPort } from "./chat.js";
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
import type { CopilotQualitySignalsPort } from "./quality.js";
import { describeNamedAgent, entity, type CopilotAgentLookupPort } from "./shared.js";

const idSchema = z.string().uuid();
const entityNameSchema = z.string().trim().min(1).max(160);

/**
 * The operator's working queue: the escalations where the next move is a person's, listed rather
 * than ranked. `workspace_triage` orients a session across every workspace signal; this answers
 * "what am I working through", and carries the handle each row's follow-up action consumes.
 */

/**
 * The kinds a person has to act on. The digest ranks every workspace signal; this list is the
 * subset where the next move is an operator's, so a failed document or an untriaged backlog count
 * belongs to `workspace_triage` and never here.
 */
const NEEDS_ATTENTION_KINDS = ["approval", "handoff", "negative_feedback"] as const;

export type CopilotNeedsAttentionKind = (typeof NEEDS_ATTENTION_KINDS)[number];

type NeedsAttentionSourceId = "approvals" | "handoffs" | "quality";

const needsAttentionSourceByKind: Record<CopilotNeedsAttentionKind, NeedsAttentionSourceId> = {
  approval: "approvals",
  handoff: "handoffs",
  negative_feedback: "quality",
};

/** How many rows the handoff window ranks per row it can list. */
const HANDOFF_RANKING_DEPTH = 10;

const NEEDS_ATTENTION_DEFAULT_LIMIT = 25;
const NEEDS_ATTENTION_MAX_LIMIT = 50;

/**
 * A working-list row. It carries the digest's clock plus the identity each follow-up action needs,
 * because a queue an operator can read but not act on sends them back to the dashboard to find the
 * same row by hand. Fields that belong to one kind are null on the others rather than absent, so
 * the row shape stays one shape.
 */
interface NeedsAttentionRow {
  readonly kind: CopilotNeedsAttentionKind;
  readonly title: string | null;
  readonly detail: string | null;
  readonly since: string;
  readonly agentId: string | null;
  readonly conversationId: string | null;
  readonly approvalHandle: string | null;
  readonly assistantMessageId: string | null;
  readonly triageState: string | null;
  readonly triageVersion: number | null;
  readonly ownerDisplayName: string | null;
  readonly takenOverAt: string | null;
  readonly subject: CopilotEntityReference;
}

export interface NeedsAttentionCopilotToolDependencies {
  readonly agentLookup?: CopilotAgentLookupPort;
  readonly pendingApprovals: CopilotPendingApprovalsPort;
  readonly chatHistoryService: CopilotConversationHistoryPort;
  readonly qualitySignalsService: CopilotQualitySignalsPort;
  readonly workspaceRouteKeyResolver: CopilotWorkspaceRouteKeyResolver;
  readonly logger?: CopilotTriageLogPort;
}

const needsAttentionInputSchema = z.object({
  agentId: idSchema.optional(),
  agentName: entityNameSchema.optional(),
  kinds: z.array(z.enum(NEEDS_ATTENTION_KINDS)).min(1).optional(),
  limit: z.number().int().min(1).max(NEEDS_ATTENTION_MAX_LIMIT).optional(),
}).strict();

const needsAttentionOutputSchema = z.object({
  items: z.array(z.object({
    kind: z.enum(NEEDS_ATTENTION_KINDS),
    /** Workspace data, never composed copy: a reason, preview, or question, or null. */
    title: z.string().nullable(),
    detail: z.string().nullable(),
    since: z.string(),
    waitingMinutes: z.number().int().nonnegative().nullable(),
    agentId: z.string().nullable(),
    conversationId: z.string().nullable(),
    /** Approvals only: the decision to resolve, which conversation id alone cannot identify. */
    approvalHandle: z.string().nullable(),
    /** Negative feedback only: the turn `set_triage_state` transitions. */
    assistantMessageId: z.string().nullable(),
    triageState: z.string().nullable(),
    /** The version `set_triage_state` must echo back for the transition to be fenced. */
    triageVersion: z.number().int().nonnegative().nullable(),
    /** Handoffs only: who holds the conversation, and null while it waits unclaimed. */
    ownerDisplayName: z.string().nullable(),
    takenOverAt: z.string().nullable(),
    dashboardUrl: z.string().startsWith("/"),
  }).strict()),
  sources: z.array(z.object({
    source: z.enum(["approvals", "handoffs", "quality"]),
    status: z.enum(["ok", "unauthorized", "failed"]),
    total: z.number().int().nonnegative().nullable(),
    included: z.number().int().nonnegative(),
  }).strict()),
}).strict();

type NeedsAttentionInput = z.infer<typeof needsAttentionInputSchema>;
type NeedsAttentionOutput = z.infer<typeof needsAttentionOutputSchema>;

const needsAttentionDescription = "Read the operator's working queue: the pending approvals, waiting handoffs, and written complaints where the next move is a person's, longest wait first. Each row carries the handle its follow-up needs — the decision handle to resolve, the assistant message id and triage version to transition, the owner of a claimed handoff. Sources report what they matched, so a bounded page is not an empty queue, and a source marked unauthorized or failed is unknown rather than zero. Use workspace_triage instead to rank every workspace signal, including failures and backlog.";

export const createNeedsAttentionCopilotTools = (
  deps: NeedsAttentionCopilotToolDependencies,
): ReadonlyArray<CopilotToolDescriptor<NeedsAttentionInput, NeedsAttentionOutput>> => [{
  name: "needs_attention",
  shape: "read",
  verificationCost: () => 0,
  uiLabel: "Reading the operator queue",
  contributingModule: "operatorCopilot",
  dashboardSubject: { type: "needs_attention" },
  requiredPermissions: ["workspace.history.read"],
  description: needsAttentionDescription,
  inputSchema: needsAttentionInputSchema,
  outputSchema: needsAttentionOutputSchema,
  createTool: (context) => ({
    name: "needs_attention",
    description: needsAttentionDescription,
    inputSchema: needsAttentionInputSchema,
    outputSchema: needsAttentionOutputSchema,
    // Same reasoning as the digest: the queue answers "who is waiting on me", so the agent on
    // screen must not silently narrow it to that agent's share.
    invoke: async (input) => buildNeedsAttention(deps, context, input),
  }),
  describeEntity: (input, context) => input.agentName
    ? describeNamedAgent(input, context, deps.agentLookup)
    : entity("agent", input.agentId),
}];

const buildNeedsAttention = async (
  deps: NeedsAttentionCopilotToolDependencies,
  context: CopilotToolInvocationContext,
  input: NeedsAttentionInput,
): Promise<NeedsAttentionOutput> => {
  const now = new Date();
  const agentId = input.agentId ?? null;
  const limit = input.limit ?? NEEDS_ATTENTION_DEFAULT_LIMIT;
  const kinds = input.kinds ?? [...NEEDS_ATTENTION_KINDS];
  const requested = new Set<CopilotNeedsAttentionKind>(kinds);

  const readers: ReadonlyArray<[CopilotNeedsAttentionKind, () => Promise<AuthorizedSourceRead<NeedsAttentionRow>>]> = [
    ["approval", () => readApprovalQueue(deps, context.workspaceId, agentId, limit)],
    ["handoff", () => readHandoffQueue(deps, context.workspaceId, agentId, limit)],
    ["negative_feedback", () => readFeedbackQueue(deps, context.workspaceId, agentId, limit)],
  ];

  const [workspaceKey, ...sources] = await Promise.all([
    deps.workspaceRouteKeyResolver.resolveWorkspaceKey(context.workspaceId),
    ...readers
      .filter(([kind]) => requested.has(kind))
      .map(([kind, read]) => readAuthorizedSource(deps, context, needsAttentionSourceByKind[kind], read)),
  ]);

  // One queue, one clock: every kind here is somebody waiting, so the longest wait leads the list
  // regardless of which source produced it. Rows with no clock sort last rather than first.
  const ordered = sources
    .flatMap((source) => source.items)
    .slice()
    .sort((left, right) => left.since.localeCompare(right.since));
  const listed = ordered.slice(0, limit);
  const includedBySource = listed.reduce((counts, item) => {
    const source = needsAttentionSourceByKind[item.kind];
    return { ...counts, [source]: (counts[source] ?? 0) + 1 };
  }, {} as Partial<Record<NeedsAttentionSourceId, number>>);

  return {
    items: listed.map((item) => ({
      kind: item.kind,
      title: clip(item.title, MAX_TITLE_CHARS),
      detail: clip(item.detail, MAX_DETAIL_CHARS),
      since: item.since,
      waitingMinutes: copilotTriageWaitingMinutes(item.since, now),
      agentId: item.agentId,
      conversationId: item.conversationId,
      approvalHandle: item.approvalHandle,
      assistantMessageId: item.assistantMessageId,
      triageState: item.triageState,
      triageVersion: item.triageVersion,
      ownerDisplayName: item.ownerDisplayName,
      takenOverAt: item.takenOverAt,
      dashboardUrl: buildCopilotDashboardLink(workspaceKey, item.subject),
    })),
    sources: sources.map(({ report }) => ({
      source: report.source,
      status: report.status,
      total: report.total,
      included: includedBySource[report.source] ?? 0,
    })),
  };
};

const emptyRowFields = {
  approvalHandle: null,
  assistantMessageId: null,
  triageState: null,
  triageVersion: null,
  ownerDisplayName: null,
  takenOverAt: null,
} as const;

const readApprovalQueue = async (
  deps: NeedsAttentionCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
  limit: number,
): Promise<AuthorizedSourceRead<NeedsAttentionRow>> => {
  const pending = (await deps.pendingApprovals.listPending(workspaceId))
    .filter((decision) => agentId === null || decision.agentId === agentId);
  return {
    total: pending.length,
    items: pending
      .slice()
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, limit)
      .map((decision) => ({
        ...emptyRowFields,
        kind: "approval" as const,
        title: decision.reason,
        detail: null,
        since: decision.createdAt.toISOString(),
        agentId: decision.agentId,
        conversationId: decision.conversationId,
        approvalHandle: decision.handle,
        subject: { type: "conversation", id: decision.conversationId },
      })),
  };
};

const readHandoffQueue = async (
  deps: NeedsAttentionCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
  limit: number,
): Promise<AuthorizedSourceRead<NeedsAttentionRow>> => {
  // The underlying read is ordered by recent activity, so the window has to be wide enough that
  // ranking it by wait time still surfaces the oldest handoff. The digest ranks 100 to list 10;
  // this list goes to 50, so a fixed 100 would let a long-forgotten handoff fall outside the window
  // while `total` reports it as merely paged away.
  const page = await deps.chatHistoryService.listConversations(workspaceId, {
    limit: Math.max(HANDOFF_RANKING_WINDOW, limit * HANDOFF_RANKING_DEPTH),
    ownership: "human_owned",
  });
  const waiting = page.conversations
    .filter((conversation) => conversation.ownership !== undefined)
    .filter((conversation) => agentId === null || conversation.agentId === agentId);
  return {
    // Same asymmetry as the digest: the page total counts every human-owned conversation, while an
    // agent-scoped count can only describe the window that was ranked.
    total: agentId === null ? page.total : waiting.length,
    items: waiting
      .slice()
      .sort((left, right) => escalatedAt(left).localeCompare(escalatedAt(right)))
      .slice(0, limit)
      .map((conversation) => ({
        ...emptyRowFields,
        kind: "handoff" as const,
        title: conversation.preview,
        detail: conversation.ownership?.reason ?? null,
        since: escalatedAt(conversation),
        agentId: conversation.agentId,
        conversationId: conversation.id,
        ownerDisplayName: conversation.ownership?.takenOverAt ? conversation.ownership.ownerDisplayName : null,
        takenOverAt: conversation.ownership?.takenOverAt ?? null,
        subject: { type: "conversation", id: conversation.id },
      })),
  };
};

const readFeedbackQueue = async (
  deps: NeedsAttentionCopilotToolDependencies,
  workspaceId: string,
  agentId: string | null,
  limit: number,
): Promise<AuthorizedSourceRead<NeedsAttentionRow>> => {
  const feedback = await deps.qualitySignalsService.listLowQualityTurns(workspaceId, {
    limit,
    ...(agentId === null ? {} : { agentId }),
    feedbackValues: ["down"],
    hasComment: true,
    activeNegativeFeedbackOnly: true,
    sort: "negative_feedback_updated_at",
  });
  return {
    total: feedback.total,
    items: feedback.items.map((turn) => ({
      ...emptyRowFields,
      kind: "negative_feedback" as const,
      title: turn.question,
      detail: latestDownComment(turn.feedback.comments),
      since: turn.feedback.latestDownUpdatedAt ?? turn.createdAt,
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      assistantMessageId: turn.assistantMessageId,
      triageState: turn.triage.state,
      triageVersion: turn.triage.version,
      subject: { type: "conversation", id: turn.conversationId },
    })),
  };
};
