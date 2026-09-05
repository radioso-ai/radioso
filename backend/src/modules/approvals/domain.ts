import type {
  PendingDecisionRecord,
} from "../../db/repositories/pendingDecisionRepository.js";

type ApprovalDecisionFailureReason =
  | "already_resolved"
  | "forbidden_decider"
  | "invalid_option"
  | "stale_proposal";

export class ApprovalDecisionDomainError extends Error {
  constructor(readonly reason: ApprovalDecisionFailureReason) {
    super(reason);
    this.name = "ApprovalDecisionDomainError";
  }
}

export interface DecisionCaller {
  accountId: string;
  workspaceId: string;
  userId?: string | null;
  principal?: {
    type: string;
    role?: "admin" | "member" | "public";
    userId?: string;
  } | null;
  workspaceRole?: "owner" | "admin" | "member" | null;
}

// A resolved gate carries the operator's exact choice. The routine branches on `optionId`
// (the `<captureKey>.id == <optionId>` decision guards), so the choice — not a binary
// approve/reject — is the decision. `label` rides along for the audit record/console.
export interface ResolvedApprovalDecision {
  decision: {
    optionId: string;
    label: string;
    payload?: unknown;
  };
}

const accountIdsFromScope = (scope: Record<string, unknown>): string[] | null => {
  if (!Array.isArray(scope.accountIds)) {
    return null;
  }
  const accountIds = scope.accountIds.filter((value): value is string => typeof value === "string");
  return accountIds.length > 0 ? accountIds : null;
};

const roleRank: Record<NonNullable<DecisionCaller["workspaceRole"]>, number> = {
  member: 1,
  admin: 2,
  owner: 3,
};

const requiredWorkspaceRole = (scope: Record<string, unknown>): DecisionCaller["workspaceRole"] => {
  if (scope.role === "owner" || scope.role === "admin" || scope.role === "member") {
    return scope.role;
  }
  return null;
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
  if (kind === "workspace_role") {
    const requiredRole = requiredWorkspaceRole(deciderScope);
    const callerRole = input.caller.workspaceRole;
    return Boolean(requiredRole && callerRole && roleRank[callerRole] >= roleRank[requiredRole]);
  }
  if (kind !== undefined && kind !== "workspace_member") {
    return false;
  }

  const accountIds = accountIdsFromScope(deciderScope);
  return !accountIds || accountIds.includes(input.caller.accountId);
};

const assertPendingDecisionOpen = (record: PendingDecisionRecord): void => {
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
  const payload = input.payload !== undefined ? input.payload : option.payload;

  return {
    decision: {
      optionId: option.id,
      label: option.label,
      ...(payload !== undefined ? { payload } : {}),
    },
  };
};
