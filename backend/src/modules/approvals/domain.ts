import type {
  PendingDecisionOutcome,
  PendingDecisionRecord,
} from "../../db/repositories/pendingDecisionRepository.js";

export type ApprovalDecisionFailureReason =
  | "already_resolved"
  | "forbidden_decider"
  | "invalid_option"
  | "stale_proposal"
  | "unknown_outcome";

export class ApprovalDecisionDomainError extends Error {
  constructor(readonly reason: ApprovalDecisionFailureReason) {
    super(reason);
    this.name = "ApprovalDecisionDomainError";
  }
}

export interface DecisionCaller {
  accountId: string;
  workspaceId: string;
}

export interface ResolvedApprovalDecision {
  outcome: PendingDecisionOutcome;
  decision: {
    optionId: string;
    outcome: PendingDecisionOutcome;
    payload?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const payloadOutcome = (payload: unknown): PendingDecisionOutcome | null => {
  if (!isRecord(payload)) {
    return null;
  }
  return payload.outcome === "approved" || payload.outcome === "rejected"
    ? payload.outcome
    : null;
};

const standardOptionOutcome = (optionId: string): PendingDecisionOutcome | null => {
  if (optionId === "approve" || optionId === "approved") {
    return "approved";
  }
  if (optionId === "reject" || optionId === "rejected") {
    return "rejected";
  }
  return null;
};

const accountIdsFromScope = (scope: Record<string, unknown>): string[] | null => {
  if (!Array.isArray(scope.accountIds)) {
    return null;
  }
  const accountIds = scope.accountIds.filter((value): value is string => typeof value === "string");
  return accountIds.length > 0 ? accountIds : null;
};

export const satisfiesDeciderScope = (input: {
  record: PendingDecisionRecord;
  caller: DecisionCaller;
}): boolean => {
  if (input.caller.workspaceId !== input.record.workspaceId) {
    return false;
  }

  const { deciderScope } = input.record;
  const kind = deciderScope.kind;
  if (kind !== undefined && kind !== "workspace_member") {
    return false;
  }

  const accountIds = accountIdsFromScope(deciderScope);
  return !accountIds || accountIds.includes(input.caller.accountId);
};

export const assertPendingDecisionOpen = (record: PendingDecisionRecord): void => {
  if (record.status !== "pending") {
    throw new ApprovalDecisionDomainError("already_resolved");
  }
};

export const resolveDecisionDomain = (input: {
  record: PendingDecisionRecord;
  optionId: string;
  payload?: unknown;
  contentHash: string;
  caller: DecisionCaller;
}): ResolvedApprovalDecision => {
  assertPendingDecisionOpen(input.record);

  if (!satisfiesDeciderScope({ record: input.record, caller: input.caller })) {
    throw new ApprovalDecisionDomainError("forbidden_decider");
  }

  if (input.contentHash !== input.record.contentHash) {
    throw new ApprovalDecisionDomainError("stale_proposal");
  }

  const option = input.record.options.find((candidate) => candidate.id === input.optionId);
  if (!option) {
    throw new ApprovalDecisionDomainError("invalid_option");
  }

  const outcome = payloadOutcome(option.payload) ?? standardOptionOutcome(option.id);
  if (!outcome) {
    throw new ApprovalDecisionDomainError("unknown_outcome");
  }

  return {
    outcome,
    decision: {
      optionId: option.id,
      outcome,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
  };
};
