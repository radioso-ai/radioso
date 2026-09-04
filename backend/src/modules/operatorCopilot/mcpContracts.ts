export const operatorMcpInvocationMethods = ["ping", "tools/list", "tools/call"] as const;
export type OperatorMcpInvocationMethod = (typeof operatorMcpInvocationMethods)[number];

export const operatorMcpInvocationShapes = ["read", "probe", "act", "propose"] as const;
export type OperatorMcpInvocationShape = (typeof operatorMcpInvocationShapes)[number];

export const operatorMcpInvocationStatuses = ["admitted", "running", "completed", "refused", "failed"] as const;
export type OperatorMcpInvocationStatus = (typeof operatorMcpInvocationStatuses)[number];

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
  readonly budgetReservedAt: Date | null;
  readonly proofNonceDigest: string;
  readonly proofConsumedAt: Date | null;
  readonly status: OperatorMcpInvocationStatus;
  readonly safeOutcomeCode: string | null;
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
  readonly proofNonceDigest: string;
  readonly now: Date;
  readonly retainedUntil: Date;
}

export type OperatorMcpInvocationAdmission =
  | { readonly status: "admitted" | "replay"; readonly invocation: OperatorMcpInvocationRecord }
  | { readonly status: "conflict" | "budget_exhausted" };

export interface OperatorMcpInvocationRepositoryPort {
  admit(input: AdmitOperatorMcpInvocationInput): Promise<OperatorMcpInvocationAdmission>;
  findById(invocationId: string): Promise<OperatorMcpInvocationRecord | null>;
  findByOperation(input: { grantId: string; operationId: string }): Promise<OperatorMcpInvocationRecord | null>;
  consumeProof(proofNonceDigest: string, now?: Date): Promise<"consumed" | "replay" | "missing">;
  markRunning(input: { invocationId: string; now: Date }): Promise<OperatorMcpInvocationRecord | null>;
  recordOutcome(input: {
    invocationId: string;
    status: "completed" | "refused" | "failed";
    safeOutcomeCode: string;
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
    now: Date;
  }): Promise<{ status: "prepared" | "replay"; invocation: OperatorMcpInvocationRecord } | { status: "conflict" | "budget_exhausted" }>;
}
