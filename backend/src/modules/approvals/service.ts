import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../db/repositories/pendingDecisionRepository.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import {
  createNoopWorkspaceInvalidationPublisher,
  createPostCommitInvalidationReceipt,
  flushPostCommitInvalidationReceipt,
  mergePostCommitInvalidationReceipts,
  type PostCommitInvalidationReceipt,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";
import {
  ApprovalDecisionDomainError,
  satisfiesDeciderScope,
  resolveDecisionDomain,
  type DecisionCaller,
  type ResolvedApprovalDecision,
} from "./domain.js";

export type ApprovalDecisionServiceFailureReason =
  | "not_found"
  | "already_resolved"
  | "forbidden_decider"
  | "invalid_option"
  | "stale_proposal"
  | "concurrent_resolution";

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
  }): Promise<ApprovalResumeResult>;
}

export interface ApprovalResumeResult {
  conversationId: string;
  resumed: true;
  assistantMessageId: string;
  postCommitReceipt: PostCommitInvalidationReceipt;
}

export interface ApprovalDecisionConversationEventPublisher {
  publishMessageCreated(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    createdAt: string;
  }): void;
}

export interface ResolveApprovalDecisionInput {
  agentId: string;
  handle: string;
  optionId: string;
  payload?: unknown;
  contentHash: string;
  caller: DecisionCaller;
}

export interface ApprovalDecisionRoleResolver {
  resolveWorkspaceRole(input: DecisionCaller): Promise<DecisionCaller["workspaceRole"]>;
}

export interface ResolveApprovalDecisionResult {
  status: "resolved";
  // The option id the operator chose (what the routine branched on), echoed back for the
  // caller's record. Not a binary approve/reject — a gate can have any author-named choices.
  optionId: string;
  conversationId: string;
  resumed: true;
}

type PendingDecisionReader = Pick<PendingDecisionRepository, "loadByHandle" | "resolveInTransaction" | "listPending">;

const mapDomainError = (error: ApprovalDecisionDomainError): ApprovalDecisionServiceError =>
  new ApprovalDecisionServiceError(error.reason);

export class ApprovalDecisionService {
  constructor(
    private readonly pendingDecisions: PendingDecisionReader,
    private readonly resumeRunner: ResumeRunner,
    private readonly roleResolver?: ApprovalDecisionRoleResolver,
    private readonly conversationEvents?: ApprovalDecisionConversationEventPublisher,
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  async listPending(workspaceId: string): Promise<PendingDecisionRecord[]> {
    return this.pendingDecisions.listPending({ workspaceId });
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

    const resume = await this.pendingDecisions.resolveInTransaction({
      handle: input.handle,
      status: "resolved",
      decision: resolved.decision,
      decidedBy: input.caller.accountId,
      contentHash: input.contentHash,
    }, async (resolvedRecord, transaction) =>
      this.resumeRunner.resume({
        record: resolvedRecord,
        optionId: resolved.decision.optionId,
        payload: resolved.decision.payload,
        decidedBy: input.caller.accountId,
        transaction,
      })
    );

    if (!resume) {
      throw new ApprovalDecisionServiceError("concurrent_resolution");
    }

    const postCommitReceipt = mergePostCommitInvalidationReceipts(
      resume.postCommitReceipt,
      createPostCommitInvalidationReceipt(record.workspaceId, ["hitl.decision_resolved"]),
    )!;
    flushPostCommitInvalidationReceipt(this.workspaceInvalidationPublisher, postCommitReceipt);

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
