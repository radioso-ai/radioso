import { sql } from "kysely";

import type {
  AdmitOperatorMcpInvocationInput,
  OperatorMcpInvocationAdmission,
  OperatorMcpInvocationRecord,
  OperatorMcpInvocationRepositoryPort,
  OperatorMcpInvocationShape,
} from "../../modules/operatorCopilot/mcpContracts.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface OperatorMcpInvocationRow {
  id: string;
  credential_id: string;
  grant_id: string;
  grant_version: string;
  account_id: string;
  workspace_id: string;
  user_id: string;
  client_id: string;
  method: "ping" | "tools/list" | "tools/call";
  descriptor_name: string | null;
  shape: OperatorMcpInvocationShape | null;
  operation_id: string | null;
  input_digest: string;
  verification_cost: number;
  budget_reserved_at: Date | null;
  proof_nonce_digest: string;
  proof_consumed_at: Date | null;
  status: "admitted" | "running" | "completed" | "refused" | "failed";
  safe_outcome_code: string | null;
  result_reference: string | null;
  created_at: Date;
  completed_at: Date | null;
  retained_until: Date;
}

const invocationColumns = sql<string>`
  id, credential_id, grant_id, grant_version::text AS grant_version,
  account_id, workspace_id, user_id, client_id, method, descriptor_name, shape,
  operation_id, input_digest, verification_cost, budget_reserved_at,
  proof_nonce_digest, proof_consumed_at, status, safe_outcome_code, result_reference,
  created_at, completed_at, retained_until
`;

const mapInvocation = (row: OperatorMcpInvocationRow): OperatorMcpInvocationRecord => ({
  id: row.id,
  credentialId: row.credential_id,
  grantId: row.grant_id,
  grantVersion: String(row.grant_version),
  accountId: row.account_id,
  workspaceId: row.workspace_id,
  userId: row.user_id,
  clientId: row.client_id,
  method: row.method,
  descriptorName: row.descriptor_name,
  shape: row.shape,
  operationId: row.operation_id,
  inputDigest: row.input_digest,
  verificationCost: Number(row.verification_cost),
  budgetReservedAt: row.budget_reserved_at ? new Date(row.budget_reserved_at) : null,
  proofNonceDigest: row.proof_nonce_digest,
  proofConsumedAt: row.proof_consumed_at ? new Date(row.proof_consumed_at) : null,
  status: row.status,
  safeOutcomeCode: row.safe_outcome_code,
  resultReference: row.result_reference,
  createdAt: new Date(row.created_at),
  completedAt: row.completed_at ? new Date(row.completed_at) : null,
  retainedUntil: new Date(row.retained_until),
});

const boundedString = (value: string | null | undefined, field: string, maximum: number): string | null => {
  if (value == null) return null;
  if (value.length === 0 || value.length > maximum) throw new Error(`${field} is outside its bounds`);
  return value;
};

const validateAdmissionInput = (input: AdmitOperatorMcpInvocationInput): void => {
  if (!Number.isInteger(input.verificationCost) || input.verificationCost < 0 || input.verificationCost > 6) {
    throw new Error("verification cost must be an integer between zero and six");
  }
  boundedString(input.descriptorName, "descriptor name", 256);
  boundedString(input.operationId, "operation id", 256);
  boundedString(input.inputDigest, "input digest", 256);
  boundedString(input.proofNonceDigest, "proof nonce digest", 256);
};

const sameOperationInput = (existing: OperatorMcpInvocationRecord, input: AdmitOperatorMcpInvocationInput): boolean =>
  existing.method === input.method
  && existing.descriptorName === (input.descriptorName ?? null)
  && existing.shape === (input.shape ?? null)
  && existing.inputDigest === input.inputDigest;

export class OperatorMcpInvocationRepository implements OperatorMcpInvocationRepositoryPort {
  private readonly verificationBudgetPerMinute: number;

  constructor(private readonly db: Db, options: { verificationBudgetPerMinute?: number } = {}) {
    const budget = options.verificationBudgetPerMinute ?? 6;
    if (!Number.isInteger(budget) || budget < 1 || budget > 6) {
      throw new Error("verification budget per minute must be an integer between one and six");
    }
    this.verificationBudgetPerMinute = budget;
  }

  async admit(input: AdmitOperatorMcpInvocationInput): Promise<OperatorMcpInvocationAdmission> {
    validateAdmissionInput(input);
    const descriptorName = input.descriptorName ?? null;
    const shape = input.shape ?? null;
    const operationId = input.operationId ?? null;

    return this.db.transaction().execute(async (trx) => {
      // A grant lock serializes reservations across backend instances. The rolling sum is
      // deliberately computed while holding this lock; a read-then-insert without it can
      // oversubscribe the six-unit ceiling under parallel calls.
      const grant = await sql<{ id: string }>`
        SELECT id FROM operator_mcp_grants WHERE id = ${input.grantId} FOR UPDATE
      `.execute(trx);
      if (grant.rows.length === 0) throw new Error("Operator MCP grant was not found");

      if (operationId !== null) {
        const existing = await sql<OperatorMcpInvocationRow>`
          SELECT ${invocationColumns}
          FROM operator_mcp_invocations
          WHERE grant_id = ${input.grantId} AND operation_id = ${operationId}
          LIMIT 1
        `.execute(trx);
        if (existing.rows[0]) {
          const invocation = mapInvocation(existing.rows[0]);
          return sameOperationInput(invocation, input)
            ? { status: "replay", invocation }
            : { status: "conflict" };
        }
      }

      if (input.verificationCost > 0) {
        const spent = await sql<{ units: string }>`
          SELECT COALESCE(SUM(verification_cost), 0)::text AS units
          FROM operator_mcp_invocations
          WHERE grant_id = ${input.grantId}
            AND budget_reserved_at IS NOT NULL
            AND budget_reserved_at >= (${input.now}::timestamptz - INTERVAL '60 seconds')
        `.execute(trx);
        if (Number(spent.rows[0]?.units ?? 0) + input.verificationCost > this.verificationBudgetPerMinute) return { status: "budget_exhausted" };
      }

      const inserted = await sql<OperatorMcpInvocationRow>`
        INSERT INTO operator_mcp_invocations (
          id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id,
          method, descriptor_name, shape, operation_id, input_digest, verification_cost,
          budget_reserved_at, proof_nonce_digest, status, created_at, retained_until
        ) VALUES (
          ${input.id}, ${input.credentialId}, ${input.grantId}, ${input.grantVersion}, ${input.accountId},
          ${input.workspaceId}, ${input.userId}, ${input.clientId}, ${input.method}, ${descriptorName},
          ${shape}, ${operationId}, ${input.inputDigest}, ${input.verificationCost},
          ${input.verificationCost > 0 ? input.now : null}, ${input.proofNonceDigest}, 'admitted',
          ${input.now}, ${input.retainedUntil}
        )
        RETURNING ${invocationColumns}
      `.execute(trx);
      const row = inserted.rows[0];
      if (!row) throw new Error("Operator MCP invocation was not admitted");
      return { status: "admitted", invocation: mapInvocation(row) };
    });
  }

  async findById(invocationId: string): Promise<OperatorMcpInvocationRecord | null> {
    const result = await sql<OperatorMcpInvocationRow>`
      SELECT ${invocationColumns}
      FROM operator_mcp_invocations
      WHERE id = ${invocationId}
      LIMIT 1
    `.execute(this.db);
    return result.rows[0] ? mapInvocation(result.rows[0]) : null;
  }

  async findByOperation(input: { grantId: string; operationId: string }): Promise<OperatorMcpInvocationRecord | null> {
    const result = await sql<OperatorMcpInvocationRow>`
      SELECT ${invocationColumns}
      FROM operator_mcp_invocations
      WHERE grant_id = ${input.grantId} AND operation_id = ${input.operationId}
      LIMIT 1
    `.execute(this.db);
    return result.rows[0] ? mapInvocation(result.rows[0]) : null;
  }

  async consumeProof(proofNonceDigest: string, now = new Date()): Promise<"consumed" | "replay" | "missing"> {
    const consumed = await sql<{ id: string }>`
      UPDATE operator_mcp_invocations
      SET proof_consumed_at = ${now}
      WHERE proof_nonce_digest = ${proofNonceDigest} AND proof_consumed_at IS NULL
      RETURNING id
    `.execute(this.db);
    if (consumed.rows.length > 0) return "consumed";
    const existing = await sql<{ id: string; proof_consumed_at: Date | null }>`
      SELECT id, proof_consumed_at
      FROM operator_mcp_invocations
      WHERE proof_nonce_digest = ${proofNonceDigest}
      LIMIT 1
    `.execute(this.db);
    return existing.rows[0] ? "replay" : "missing";
  }

  async markRunning(input: { invocationId: string; now: Date }): Promise<OperatorMcpInvocationRecord | null> {
    await sql`
      UPDATE operator_mcp_invocations
      SET status = 'running'
      WHERE id = ${input.invocationId} AND status = 'admitted'
    `.execute(this.db);
    return this.findById(input.invocationId);
  }

  async recordOutcome(input: {
    invocationId: string;
    status: "completed" | "refused" | "failed";
    safeOutcomeCode: string;
    resultReference?: string | null;
    now: Date;
  }): Promise<OperatorMcpInvocationRecord | null> {
    const safeOutcomeCode = boundedString(input.safeOutcomeCode, "safe outcome code", 128);
    if (!safeOutcomeCode) throw new Error("safe outcome code is required");
    const resultReference = boundedString(input.resultReference, "result reference", 512);
    const updated = await sql<OperatorMcpInvocationRow>`
      UPDATE operator_mcp_invocations
      SET status = ${input.status}, safe_outcome_code = ${safeOutcomeCode},
          result_reference = ${resultReference}, completed_at = ${input.now}
      WHERE id = ${input.invocationId} AND status IN ('admitted', 'running')
      RETURNING ${invocationColumns}
    `.execute(this.db);
    return updated.rows[0] ? mapInvocation(updated.rows[0]) : this.findById(input.invocationId);
  }

  async refundReservation(input: { invocationId: string; now: Date }): Promise<boolean> {
    const refunded = await sql`
      UPDATE operator_mcp_invocations
      SET status = 'refused', safe_outcome_code = 'refused_before_effect',
          budget_reserved_at = NULL, completed_at = ${input.now}
      WHERE id = ${input.invocationId} AND status = 'admitted'
      RETURNING id
    `.execute(this.db);
    return refunded.rows.length > 0;
  }

  async prepareInvocation(input: {
    invocationId: string; operationId: string | null; descriptorName: string; shape: OperatorMcpInvocationShape;
    inputDigest: string; verificationCost: number; now: Date;
  }): Promise<{ status: "prepared" | "replay"; invocation: OperatorMcpInvocationRecord } | { status: "conflict" | "budget_exhausted" }> {
    if (!Number.isInteger(input.verificationCost) || input.verificationCost < 0 || input.verificationCost > 6) {
      throw new Error("verification cost must be an integer between zero and six");
    }
    return this.db.transaction().execute(async (trx) => {
      const selected = await sql<OperatorMcpInvocationRow>`
        SELECT ${invocationColumns} FROM operator_mcp_invocations
        WHERE id = ${input.invocationId} FOR UPDATE
      `.execute(trx);
      const currentRow = selected.rows[0];
      if (!currentRow) throw new Error("Operator MCP invocation was not admitted");
      const current = mapInvocation(currentRow);
      await sql`SELECT id FROM operator_mcp_grants WHERE id = ${current.grantId} FOR UPDATE`.execute(trx);
      if (input.operationId) {
        const existing = await sql<OperatorMcpInvocationRow>`
          SELECT ${invocationColumns} FROM operator_mcp_invocations
          WHERE grant_id = ${current.grantId} AND operation_id = ${input.operationId} AND id <> ${input.invocationId}
          LIMIT 1
        `.execute(trx);
        if (existing.rows[0]) {
          const invocation = mapInvocation(existing.rows[0]);
          return invocation.descriptorName === input.descriptorName && invocation.inputDigest === input.inputDigest
            ? { status: "replay" as const, invocation }
            : { status: "conflict" as const };
        }
      }
      if (current.status !== "admitted" || current.descriptorName !== input.descriptorName) return { status: "conflict" as const };
      if (input.verificationCost > 0) {
        const spent = await sql<{ units: string }>`
          SELECT COALESCE(SUM(verification_cost), 0)::text AS units FROM operator_mcp_invocations
          WHERE grant_id = ${current.grantId} AND id <> ${input.invocationId}
            AND budget_reserved_at IS NOT NULL
            AND budget_reserved_at >= (${input.now}::timestamptz - INTERVAL '60 seconds')
        `.execute(trx);
        if (Number(spent.rows[0]?.units ?? 0) + input.verificationCost > this.verificationBudgetPerMinute) return { status: "budget_exhausted" as const };
      }
      const updated = await sql<OperatorMcpInvocationRow>`
        UPDATE operator_mcp_invocations SET operation_id = ${input.operationId}, shape = ${input.shape},
          input_digest = ${input.inputDigest}, verification_cost = ${input.verificationCost},
          budget_reserved_at = ${input.verificationCost > 0 ? input.now : null}
        WHERE id = ${input.invocationId} AND status = 'admitted'
        RETURNING ${invocationColumns}
      `.execute(trx);
      if (!updated.rows[0]) return { status: "conflict" as const };
      return { status: "prepared" as const, invocation: mapInvocation(updated.rows[0]) };
    });
  }
}
