import type {
  PendingDecisionRecord,
  PendingDecisionRepository,
} from "../../db/repositories/pendingDecisionRepository.js";
import type { DatabaseExecutor } from "../../shared/infra/database.js";
import {
  ApprovalDecisionDomainError,
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
  | "concurrent_resolution"
  | "unknown_outcome";

export class ApprovalDecisionServiceError extends Error {
  constructor(readonly reason: ApprovalDecisionServiceFailureReason) {
    super(reason);
    this.name = "ApprovalDecisionServiceError";
  }
}

export interface ResumeRunner {
  resume(input: {
    record: PendingDecisionRecord;
    outcome: ResolvedApprovalDecision["outcome"];
    payload?: unknown;
    decidedBy: string;
    executor: DatabaseExecutor;
  }): Promise<{ conversationId: string; resumed: boolean }>;
}

export interface ResolveApprovalDecisionInput {
  agentId: string;
  handle: string;
  optionId: string;
  payload?: unknown;
  contentHash: string;
  caller: DecisionCaller;
}

export interface ResolveApprovalDecisionResult {
  status: "resolved";
  decision: ResolvedApprovalDecision["outcome"];
  conversationId: string;
  resumed: boolean;
}

type PendingDecisionReader = Pick<PendingDecisionRepository, "loadByHandle" | "resolveInTransaction">;

const mapDomainError = (error: ApprovalDecisionDomainError): ApprovalDecisionServiceError =>
  new ApprovalDecisionServiceError(error.reason);

export class ApprovalDecisionService {
  constructor(
    private readonly pendingDecisions: PendingDecisionReader,
    private readonly resumeRunner: ResumeRunner,
  ) {}

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
        caller: input.caller,
      });
    } catch (error) {
      if (error instanceof ApprovalDecisionDomainError) {
        throw mapDomainError(error);
      }
      throw error;
    }

    const resume = await this.pendingDecisions.resolveInTransaction({
      handle: input.handle,
      outcome: resolved.outcome,
      decision: resolved.decision,
      decidedBy: input.caller.accountId,
      contentHash: input.contentHash,
    }, async (resolvedRecord, executor) =>
      this.resumeRunner.resume({
        record: resolvedRecord,
        outcome: resolved.outcome,
        payload: input.payload,
        decidedBy: input.caller.accountId,
        executor,
      })
    );

    if (!resume) {
      throw new ApprovalDecisionServiceError("concurrent_resolution");
    }

    return {
      status: "resolved",
      decision: resolved.outcome,
      conversationId: resume.conversationId,
      resumed: resume.resumed,
    };
  }
}
