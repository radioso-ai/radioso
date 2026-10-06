import type { AccountPermission } from "../../account/public.js";
import type { HeldReplyService, HeldReplyView, OwnershipActor } from "../../handoff/public.js";
import type { CopilotToolInvocationContext } from "../contracts.js";
import type { CopilotTriageSourceId, CopilotTriageSourceReport } from "../triageDigest.js";
import type { CopilotConversationSummary } from "./chat.js";

/**
 * Reading what is waiting on a person, under the permission each source is really gated on.
 *
 * Both operator-facing reads compose the same sources — `workspace_triage` ranks them into a
 * digest, `needs_attention` lists them as a queue — so the authorization model, the failure
 * reporting, and the clock live here rather than in either tool.
 */

/**
 * How many waiting handoffs are ranked before a cap applies. The underlying list is ordered by
 * recent activity, so ranking over one page of ten would return the ten most recently active
 * handoffs and call the oldest of those the longest wait. Ranking over a wide window and listing
 * a narrow one keeps the top of the result correct.
 */
export const HANDOFF_RANKING_WINDOW = 100;
export const MAX_TITLE_CHARS = 160;
export const MAX_DETAIL_CHARS = 240;

export interface CopilotPendingApproval {
  /** The decision's own identity: two approvals can be pending on one conversation. */
  readonly handle: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface CopilotPendingApprovalsPort {
  listPending(workspaceId: string): Promise<ReadonlyArray<CopilotPendingApproval>>;
}

/** A reply that may not have reached the customer. */
export interface CopilotDeliveryFailure {
  readonly conversationId: string;
  /** The delivering channel's enum code: `bounced`, `failed`, `uncertain` or `halted`. */
  readonly kind: string;
  /** The provider's code, sanitized; never its bounce message. */
  readonly detailCode: string | null;
  readonly openedAt: Date;
}

/** The open delivery failures, newest first, a page at a time. */
export interface CopilotDeliveryFailuresPort {
  listOpen(workspaceId: string, query: { agentId?: string; cursor?: string; limit: number }): Promise<{
    readonly items: ReadonlyArray<CopilotDeliveryFailure>;
    readonly nextCursor: string | null;
  }>;
}

/**
 * Replies an agent wrote in review that wait for a teammate, read through handoff's operator port
 * as the signed-in teammate. They are approvals: the `approvals` source lists them beside the
 * routine decisions, and `held_replies` reads them whole.
 */
export type CopilotHeldRepliesPort = Pick<HeldReplyService, "list" | "current">;

/** Records a source Ray could not read, so a swallowed failure is still traceable in support. */
export interface CopilotTriageLogPort {
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * Each source reads under its own permission rather than a tool requiring the union. A member role
 * holds no quality permission, so an all-of gate would take the whole result away from the
 * operators it exists to orient. Exported so the turn route can be checked for resolving every one
 * of these: a permission the route never resolves makes its section permanently unauthorized.
 */
export const copilotTriageSourcePermissions: Record<CopilotTriageSourceId, AccountPermission> = {
  approvals: "workspace.conversation.takeover",
  handoffs: "workspace.history.read",
  quality: "workspace.quality.read",
  documents: "workspace.documents.read",
  document_sources: "workspace.documents.read",
  evals: "workspace.retrieval.query",
  // Read from the Inbox, where a teammate acknowledges or resolves one, so it takes the Inbox's permission.
  delivery_failures: "workspace.conversation.takeover",
};

/** What one authorized source read produced: the rows it listed and the rows it matched. */
export interface AuthorizedSourceRead<TRow> {
  readonly items: ReadonlyArray<TRow>;
  /** Rows matched of the kinds this source lists individually, before the cap. */
  readonly total: number;
}

/**
 * Reads one source under its own permission, and turns a failure into a stated gap rather than an
 * absent section. #942's lesson: a result that renders "could not read" as zero tells the operator
 * their workspace is clear.
 */
export const readAuthorizedSource = async <TRow, TSource extends CopilotTriageSourceId>(
  deps: { readonly logger?: CopilotTriageLogPort },
  context: CopilotToolInvocationContext,
  source: TSource,
  read: () => Promise<AuthorizedSourceRead<TRow>>,
): Promise<{ report: Omit<CopilotTriageSourceReport, "included" | "source"> & { source: TSource }; items: ReadonlyArray<TRow> }> => {
  const permission = copilotTriageSourcePermissions[source];
  const authorized = await context.currentAuthorization.hasAllPermissions({
    workspaceId: context.workspaceId,
    accountId: context.accountId,
    operatorUserId: context.operatorUserId,
    requiredPermissions: [permission],
  });
  if (!authorized) {
    return { report: { source, status: "unauthorized", total: null }, items: [] };
  }
  try {
    const result = await read();
    // Each source may take a different amount of time. Recheck its own permission before the
    // rows become part of the aggregate, so a revocation during this read cannot leak a line.
    const stillAuthorized = await context.currentAuthorization.hasAllPermissions({
      workspaceId: context.workspaceId,
      accountId: context.accountId,
      operatorUserId: context.operatorUserId,
      requiredPermissions: [permission],
    });
    if (!stillAuthorized) {
      return { report: { source, status: "unauthorized", total: null }, items: [] };
    }
    return { report: { source, status: "ok", total: result.total }, items: result.items };
  } catch (error) {
    deps.logger?.warn(
      { workspaceId: context.workspaceId, source, error: error instanceof Error ? error.message : "unknown" },
      "Escalation source could not be read",
    );
    return { report: { source, status: "failed", total: null }, items: [] };
  }
};

const OPEN_ROW_PAGE_SIZE = 100;
/**
 * How many of a paged source's open rows are returned, longest wait first. Open delivery failures
 * and held replies are the exception — each is a reply a person has to look at — so every page is
 * read and counted; only the rows kept are bounded, which keeps a pathological backlog's memory flat.
 */
const OPEN_ROW_RANKING_WINDOW = 1_000;

/**
 * Every page of a newest-first reader, counted in full, keeping the `OPEN_ROW_RANKING_WINDOW`
 * longest waits. The longest waits are on its last page, so a reader that stopped early would
 * report a partial total and rank newer rows as the longest waiting.
 */
const readLongestWaits = async <TRow>(
  waitingSince: (row: TRow) => Date,
  readPage: (cursor: string | null) => Promise<{ readonly items: ReadonlyArray<TRow>; readonly nextCursor: string | null }>,
): Promise<AuthorizedSourceRead<TRow>> => {
  const byLongestWait = (left: TRow, right: TRow): number => waitingSince(left).getTime() - waitingSince(right).getTime();
  let kept: TRow[] = [];
  let total = 0;
  let cursor: string | null = null;
  do {
    const page = await readPage(cursor);
    total += page.items.length;
    kept = [...kept, ...page.items].sort(byLongestWait).slice(0, OPEN_ROW_RANKING_WINDOW);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { total, items: kept };
};

/** A workspace's open delivery failures, longest wait first. */
export const readOpenDeliveryFailures = (
  port: CopilotDeliveryFailuresPort,
  workspaceId: string,
  agentId: string | null,
): Promise<AuthorizedSourceRead<CopilotDeliveryFailure>> =>
  readLongestWaits((failure) => failure.openedAt, (cursor) => port.listOpen(workspaceId, {
    ...(agentId === null ? {} : { agentId }),
    ...(cursor === null ? {} : { cursor }),
    limit: OPEN_ROW_PAGE_SIZE,
  }));

/** The held replies waiting for a teammate, longest wait first, read as the signed-in teammate. */
export const readOpenHeldReplies = (
  port: CopilotHeldRepliesPort,
  actor: OwnershipActor,
  agentId: string | null,
): Promise<AuthorizedSourceRead<HeldReplyView>> =>
  readLongestWaits((heldReply) => heldReply.createdAt, (cursor) => port.list(actor, {
    attention: "open",
    ...(agentId === null ? {} : { agentId }),
    ...(cursor === null ? {} : { cursor }),
    limit: OPEN_ROW_PAGE_SIZE,
  }));

/** The teammate a Ray turn reads as, for the operator ports that take one. */
export const copilotOperatorActor = (context: CopilotToolInvocationContext): OwnershipActor => ({
  workspaceId: context.workspaceId,
  accountId: context.accountId,
  userId: context.operatorUserId,
});

/** When the wait started: ownership's own clock while a person holds it, the conversation's otherwise. */
export const escalatedAt = (conversation: CopilotConversationSummary): string =>
  conversation.ownership?.updatedAt ?? conversation.updatedAt;

export const latestDownComment = (
  comments: ReadonlyArray<{ value: string; comment: string; updatedAt: string }>,
): string | null => comments
  .filter((entry) => entry.value === "down")
  .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.comment ?? null;

export const clip = (value: string | null, max: number): string | null =>
  value === null ? null : (value.length <= max ? value : value.slice(0, max));
