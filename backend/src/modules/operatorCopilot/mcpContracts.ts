export type OperatorMcpInvocationMethod = "ping" | "tools/list" | "tools/call";

export const operatorMcpInvocationShapes = ["read", "probe", "act", "propose"] as const;
export type OperatorMcpInvocationShape = (typeof operatorMcpInvocationShapes)[number];

export type OperatorMcpInvocationStatus = "admitted" | "running" | "completed" | "refused" | "failed";

/**
 * Which per-minute ceiling a call's verification cost is charged against. `verification` is the
 * shared budget every probe or propose descriptor draws from by default. `test_chat` is Test
 * Chat's own, larger ceiling: those turns are private, suppress skill effects, and are already
 * metered as answers against the plan quota, so bounding them against the shared verification
 * budget would stall an ordinary multi-turn routine test for no protective reason.
 */
export const operatorMcpBudgetKinds = ["verification", "test_chat"] as const;
export type OperatorMcpBudgetKind = (typeof operatorMcpBudgetKinds)[number];

/** What a caller may retry after once its budget is spent for the current rolling window. */
export interface OperatorMcpBudgetRetry {
  readonly retryAfterSeconds: number;
  readonly resetAt: Date;
}

export interface OperatorMcpInvocationRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly grantId: string;
  readonly grantVersion: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly method: OperatorMcpInvocationMethod;
  readonly descriptorName: string | null;
  readonly shape: OperatorMcpInvocationShape | null;
  readonly operationId: string | null;
  readonly inputDigest: string;
  readonly verificationCost: number;
  readonly budgetKind: OperatorMcpBudgetKind;
  readonly budgetReservedAt: Date | null;
  readonly proofNonceDigest: string;
  readonly proofConsumedAt: Date | null;
  readonly status: OperatorMcpInvocationStatus;
  readonly safeOutcomeCode: string | null;
  readonly safeRejectionDetails: readonly OperatorMcpRejectionDetail[];
  readonly resultReference: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly retainedUntil: Date;
}

export interface AdmitOperatorMcpInvocationInput {
  readonly id: string;
  readonly credentialId: string;
  readonly grantId: string;
  readonly grantVersion: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly method: OperatorMcpInvocationMethod;
  readonly descriptorName?: string | null;
  readonly shape?: OperatorMcpInvocationShape | null;
  readonly operationId?: string | null;
  readonly inputDigest: string;
  readonly verificationCost: number;
  /** Omitted means the shared `verification` budget: only a `tools/call` admission ever needs another kind, and admission always reserves zero. */
  readonly budgetKind?: OperatorMcpBudgetKind;
  readonly proofNonceDigest: string;
  readonly now: Date;
  readonly retainedUntil: Date;
}

export type OperatorMcpInvocationAdmission =
  | { readonly status: "admitted" | "replay"; readonly invocation: OperatorMcpInvocationRecord }
  | { readonly status: "conflict" }
  | ({ readonly status: "budget_exhausted" } & OperatorMcpBudgetRetry);

export interface OperatorMcpInvocationRepositoryPort {
  admit(input: AdmitOperatorMcpInvocationInput): Promise<OperatorMcpInvocationAdmission>;
  findById(invocationId: string): Promise<OperatorMcpInvocationRecord | null>;
  findByOperation(input: { grantId: string; operationId: string }): Promise<OperatorMcpInvocationRecord | null>;
  consumeProof(proofNonceDigest: string, now?: Date): Promise<"consumed" | "replay" | "missing">;
  claimRunning(input: { invocationId: string; now: Date }): Promise<OperatorMcpInvocationRecord | null>;
  recordOutcome(input: {
    invocationId: string;
    status: "completed" | "refused" | "failed";
    safeOutcomeCode: string;
    safeRejectionDetails?: readonly OperatorMcpRejectionDetail[];
    resultReference?: string | null;
    now: Date;
  }): Promise<OperatorMcpInvocationRecord | null>;
  refundReservation(input: { invocationId: string; now: Date }): Promise<boolean>;
  prepareInvocation(input: {
    invocationId: string;
    operationId: string | null;
    descriptorName: string;
    shape: OperatorMcpInvocationShape;
    inputDigest: string;
    verificationCost: number;
    budgetKind: OperatorMcpBudgetKind;
    now: Date;
  }): Promise<
    | { status: "prepared" | "replay"; invocation: OperatorMcpInvocationRecord }
    | { status: "conflict" }
    | ({ status: "budget_exhausted" } & OperatorMcpBudgetRetry)
  >;
}
import type { OperatorMcpRejectionDetail } from "./invalidArgumentDetails.js";
