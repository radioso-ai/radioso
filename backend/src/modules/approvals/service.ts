import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../db/repositories/pendingDecisionRepository.js";
import { createHash } from "node:crypto";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  ApprovalResumeEffectJournalConflictError,
  type ApprovalResumeEffectJournal,
} from "../routines/public.js";
import {
  createNoopWorkspaceInvalidationPublisher,
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  mergePostCommitInvalidationReceipts,
  type PostCommitInvalidationReceipt,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import type { ConversationActivityRecorder } from "../conversationActivity/contracts/index.js";
import {
  ApprovalDecisionDomainError,
  satisfiesDeciderScope,
  resolveDecisionDomain,
  type DecisionCaller,
  type ResolvedApprovalDecision,
} from "./domain.js";

type ApprovalDecisionServiceFailureReason =
  | "not_found"
  | "already_resolved"
  | "forbidden_decider"
  | "invalid_option"
  | "stale_proposal"
  | "concurrent_resolution"
  | "effect_journal_conflict";

export class ApprovalDecisionServiceError extends Error {
  constructor(readonly reason: ApprovalDecisionServiceFailureReason) {
    super(reason);
    this.name = "ApprovalDecisionServiceError";
  }
}

export interface ResumeRunner {
  resume(input: {
    record: PendingDecisionRecord;
    // The exact option the operator chose, used as the engine decision id: a routine
    // branches on the option id via its `<captureKey>.id == <optionId>` decision guards.
    optionId: string;
    payload?: unknown;
    decidedBy: string;
    transaction: Db;
    /** Stable, non-secret identity for deduping skill effects across a rolled-back resume. */
    skillDispatchIdempotencyKey?: string;
    approvalResume?: { pendingDecisionId: string; optionId: string; payloadDigest: string };
  }): Promise<ApprovalResumeResult>;
}

export interface ApprovalResumeResult {
  conversationId: string;
  resumed: true;
  assistantMessageId: string;
  postCommitReceipt: PostCommitInvalidationReceipt;
  /** Wakes the worker for background jobs the resumed turn wrote; called once the decision's transaction commits. */
  postCommitWake?: () => void;
}

interface ApprovalDecisionConversationEventPublisher {
  publishMessageCreated(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    createdAt: string;
  }): void;
}

interface ResolveApprovalDecisionInput {
  agentId: string;
  handle: string;
  optionId: string;
  payload?: unknown;
  contentHash: string;
  caller: DecisionCaller;
}

interface ApprovalDecisionRoleResolver {
  resolveWorkspaceRole(input: DecisionCaller): Promise<DecisionCaller["workspaceRole"]>;
}

interface ResolveApprovalDecisionResult {
  status: "resolved";
  // The option id the operator chose (what the routine branched on), echoed back for the
  // caller's record. Not a binary approve/reject — a gate can have any author-named choices.
  optionId: string;
  conversationId: string;
  resumed: true;
}

type PendingDecisionReader = Pick<PendingDecisionRepository, "loadByHandle" | "resolveInTransaction" | "listPending">;

const canonicalPayload = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalPayload(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const payloadDigest = (payload: { present: boolean; value?: unknown }): string =>
  createHash("sha256").update(canonicalPayload(payload)).digest("hex");

const mapDomainError = (error: ApprovalDecisionDomainError): ApprovalDecisionServiceError =>
  new ApprovalDecisionServiceError(error.reason);

export class ApprovalDecisionService {
  constructor(
    private readonly pendingDecisions: PendingDecisionReader,
    private readonly resumeRunner: ResumeRunner,
    // Records who decided, in the transaction that resolves the decision.
    private readonly activity: ConversationActivityRecorder,
    private readonly roleResolver?: ApprovalDecisionRoleResolver,
    private readonly conversationEvents?: ApprovalDecisionConversationEventPublisher,
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
    private readonly effectJournal?: ApprovalResumeEffectJournal,
  ) {}

  async listPending(workspaceId: string, filters: { agentId?: string; channel?: string } = {}): Promise<PendingDecisionRecord[]> {
    return this.pendingDecisions.listPending({ workspaceId, ...filters });
  }

  async canResolve(record: PendingDecisionRecord, caller: DecisionCaller): Promise<boolean> {
    return satisfiesDeciderScope({
      record,
      caller: await this.resolveCaller(caller),
    });
  }

  async resolve(input: ResolveApprovalDecisionInput): Promise<ResolveApprovalDecisionResult> {
    const record = await this.pendingDecisions.loadByHandle(input.handle);
    if (!record) {
      throw new ApprovalDecisionServiceError("not_found");
    }
    if (record.agentId !== input.agentId) {
      throw new ApprovalDecisionServiceError("not_found");
    }

    let resolved: ResolvedApprovalDecision;
    try {
      resolved = resolveDecisionDomain({
        record,
        optionId: input.optionId,
        payload: input.payload,
        contentHash: input.contentHash,
        caller: await this.resolveCaller(input.caller),
      });
    } catch (error) {
      if (error instanceof ApprovalDecisionDomainError) {
        throw mapDomainError(error);
      }
      throw error;
    }

    const decidedByUserId = input.caller.userId ?? null;
    const journalDecision = {
      pendingDecisionId: record.id,
      optionId: resolved.decision.optionId,
      payloadDigest: payloadDigest(
        resolved.decision.payload === undefined
          ? { present: false }
          : { present: true, value: resolved.decision.payload },
      ),
    };
    try {
      await this.effectJournal?.assertDecision(journalDecision);
    } catch (error) {
      if (error instanceof ApprovalResumeEffectJournalConflictError) {
        throw new ApprovalDecisionServiceError("effect_journal_conflict");
      }
      throw error;
    }
    const resume = await this.pendingDecisions.resolveInTransaction({
      handle: input.handle,
      status: "resolved",
      decision: resolved.decision,
      decidedBy: input.caller.accountId,
      decidedByUserId,
      contentHash: input.contentHash,
    }, async (resolvedRecord, transaction) => {
      // Recorded before the resume's reply, so the decision dates before the turn it resumes.
      await this.activity.record(transaction, {
        kind: "approval_decided",
        conversationId: resolvedRecord.conversationId,
        workspaceId: resolvedRecord.workspaceId,
        actorUserId: decidedByUserId,
        detail: {
          handle: resolvedRecord.handle,
          decision: { optionId: resolved.decision.optionId, label: resolved.decision.label },
        },
      });
      try {
        const result = await this.resumeRunner.resume({
          record: resolvedRecord,
          optionId: resolved.decision.optionId,
          payload: resolved.decision.payload,
          decidedBy: input.caller.accountId,
          transaction,
          skillDispatchIdempotencyKey: `approval-decision:${resolvedRecord.id}`,
          approvalResume: { ...journalDecision, pendingDecisionId: resolvedRecord.id },
        });
        await this.effectJournal?.clearDecision({ pendingDecisionId: resolvedRecord.id, transaction });
        return result;
      } catch (error) {
        if (error instanceof ApprovalResumeEffectJournalConflictError) {
          throw new ApprovalDecisionServiceError("effect_journal_conflict");
        }
        throw error;
      }
    });

    if (!resume) {
      throw new ApprovalDecisionServiceError("concurrent_resolution");
    }

    const postCommitReceipt = mergePostCommitInvalidationReceipts(
      resume.postCommitReceipt,
      createPostCommitInvalidationReceipt(record.workspaceId, ["hitl.decision_resolved"]),
    )!;
    flushPostCommitInvalidationReceipt(this.workspaceInvalidationPublisher, postCommitReceipt);
    resume.postCommitWake?.();

    this.conversationEvents?.publishMessageCreated({
      workspaceId: record.workspaceId,
      conversationId: resume.conversationId,
      messageId: resume.assistantMessageId,
      createdAt: new Date().toISOString(),
    });

    return {
      status: "resolved",
      optionId: resolved.decision.optionId,
      conversationId: resume.conversationId,
      resumed: resume.resumed,
    };
  }

  private async resolveCaller(caller: DecisionCaller): Promise<DecisionCaller> {
    if (caller.workspaceRole !== undefined || !this.roleResolver) {
      return caller;
    }
    return {
      ...caller,
      workspaceRole: await this.roleResolver.resolveWorkspaceRole(caller),
    };
  }
}
