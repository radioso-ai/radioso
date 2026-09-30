import { sql } from "kysely";

import type {
  AdmitOperatorMcpInvocationInput,
  OperatorMcpBudgetKind,
  OperatorMcpBudgetRetry,
  OperatorMcpInvocationAdmission,
  OperatorMcpInvocationRecord,
  OperatorMcpInvocationRepositoryPort,
  OperatorMcpInvocationShape,
} from "../../modules/operatorCopilot/mcpContracts.js";
import { boundRejectionDetails } from "../../modules/operatorCopilot/invalidArgumentDetails.js";
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
  budget_kind: OperatorMcpBudgetKind;
  budget_reserved_at: Date | null;
  proof_nonce_digest: string;
  proof_consumed_at: Date | null;
  status: "admitted" | "running" | "completed" | "refused" | "failed";
  safe_outcome_code: string | null;
  safe_rejection_details: unknown;
  result_reference: string | null;
  created_at: Date;
  completed_at: Date | null;
  retained_until: Date;
}

const invocationColumns = sql<string>`
  id, credential_id, grant_id, grant_version::text AS grant_version,
  account_id, workspace_id, user_id, client_id, method, descriptor_name, shape,
  operation_id, input_digest, verification_cost, budget_kind, budget_reserved_at,
  proof_nonce_digest, proof_consumed_at, status, safe_outcome_code, safe_rejection_details, result_reference,
  created_at, completed_at, retained_until
`;

/**
 * Default per-grant ceilings for the two rolling one-minute budgets. Verification stays at the
 * protocol maximum of six: every other probe or propose descriptor still shares it unchanged.
 * Test Chat draws from its own, larger ceiling -- its turns are private, suppress skill effects,
 * and are already metered as answers against the plan quota -- sized for a couple of parallel
 * pre-release conversations at human-ish pacing (6-8 turns each) with headroom, while the cap
 * still stops a runaway client loop.
 */
const DEFAULT_VERIFICATION_BUDGET_PER_MINUTE = 6;
const MAX_VERIFICATION_BUDGET_PER_MINUTE = 6;
const DEFAULT_TEST_CHAT_BUDGET_PER_MINUTE = 30;
const MAX_TEST_CHAT_BUDGET_PER_MINUTE = 60;
const BUDGET_WINDOW_MS = 60_000;

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
  budgetKind: row.budget_kind,
  budgetReservedAt: row.budget_reserved_at ? new Date(row.budget_reserved_at) : null,
  proofNonceDigest: row.proof_nonce_digest,
  proofConsumedAt: row.proof_consumed_at ? new Date(row.proof_consumed_at) : null,
  status: row.status,
  safeOutcomeCode: row.safe_outcome_code,
  safeRejectionDetails: boundRejectionDetails(row.safe_rejection_details),
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

/**
 * When a grant is over its ceiling, the caller needs to know when a unit frees up rather than only
 * that it cannot spend one now. The window is a trailing 60 seconds per grant and kind, so the
 * earliest reservation still inside it is the one that ages out first; a minute after it was made,
 * at least one unit is free again. Excluding `excludeInvocationId` matters only for
 * `prepareInvocation`'s retry, whose own row was admitted with no reservation yet and so would
 * never match regardless, but the exclusion mirrors the spend query it is computed alongside.
 */
const budgetRetryInfo = async (
  db: Db,
  input: { grantId: string; kind: OperatorMcpBudgetKind; now: Date; excludeInvocationId: string | null },
): Promise<OperatorMcpBudgetRetry> => {
  const earliest = await sql<{ earliest: Date | null }>`
    SELECT MIN(budget_reserved_at) AS earliest
    FROM operator_mcp_invocations
    WHERE grant_id = ${input.grantId} AND budget_kind = ${input.kind}
      AND budget_reserved_at IS NOT NULL
      AND budget_reserved_at >= (${input.now}::timestamptz - INTERVAL '60 seconds')
      AND (${input.excludeInvocationId}::uuid IS NULL OR id <> ${input.excludeInvocationId}::uuid)
  `.execute(db);
  const earliestReservedAt = earliest.rows[0]?.earliest ? new Date(earliest.rows[0].earliest) : input.now;
  const resetAt = new Date(earliestReservedAt.getTime() + BUDGET_WINDOW_MS);
  return { resetAt, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - input.now.getTime()) / 1000)) };
};

export class OperatorMcpInvocationRepository implements OperatorMcpInvocationRepositoryPort {
  private readonly verificationBudgetPerMinute: number;
  private readonly testChatBudgetPerMinute: number;

  constructor(
    private readonly db: Db,
    options: { verificationBudgetPerMinute?: number; testChatBudgetPerMinute?: number } = {},
  ) {
    const verificationBudget = options.verificationBudgetPerMinute ?? DEFAULT_VERIFICATION_BUDGET_PER_MINUTE;
    if (!Number.isInteger(verificationBudget) || verificationBudget < 1 || verificationBudget > MAX_VERIFICATION_BUDGET_PER_MINUTE) {
      throw new Error("verification budget per minute must be an integer between one and six");
    }
    this.verificationBudgetPerMinute = verificationBudget;
    const testChatBudget = options.testChatBudgetPerMinute ?? DEFAULT_TEST_CHAT_BUDGET_PER_MINUTE;
    if (!Number.isInteger(testChatBudget) || testChatBudget < 1 || testChatBudget > MAX_TEST_CHAT_BUDGET_PER_MINUTE) {
      throw new Error(`test chat budget per minute must be an integer between one and ${MAX_TEST_CHAT_BUDGET_PER_MINUTE}`);
    }
    this.testChatBudgetPerMinute = testChatBudget;
  }

  private budgetLimit(kind: OperatorMcpBudgetKind): number {
    return kind === "test_chat" ? this.testChatBudgetPerMinute : this.verificationBudgetPerMinute;
  }

  async admit(input: AdmitOperatorMcpInvocationInput): Promise<OperatorMcpInvocationAdmission> {
    validateAdmissionInput(input);
    const descriptorName = input.descriptorName ?? null;
    const shape = input.shape ?? null;
    const operationId = input.operationId ?? null;
    const budgetKind = input.budgetKind ?? "verification";

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
            AND (status <> 'refused' OR safe_outcome_code IS DISTINCT FROM 'abandoned_before_effect')
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
          WHERE grant_id = ${input.grantId} AND budget_kind = ${budgetKind}
            AND budget_reserved_at IS NOT NULL
            AND budget_reserved_at >= (${input.now}::timestamptz - INTERVAL '60 seconds')
        `.execute(trx);
        if (Number(spent.rows[0]?.units ?? 0) + input.verificationCost > this.budgetLimit(budgetKind)) {
          return { status: "budget_exhausted", ...await budgetRetryInfo(trx, { grantId: input.grantId, kind: budgetKind, now: input.now, excludeInvocationId: null }) };
        }
      }

      const inserted = await sql<OperatorMcpInvocationRow>`
        INSERT INTO operator_mcp_invocations (
          id, credential_id, grant_id, grant_version, account_id, workspace_id, user_id, client_id,
          method, descriptor_name, shape, operation_id, input_digest, verification_cost, budget_kind,
          budget_reserved_at, proof_nonce_digest, status, created_at, retained_until
        ) VALUES (
          ${input.id}, ${input.credentialId}, ${input.grantId}, ${input.grantVersion}, ${input.accountId},
          ${input.workspaceId}, ${input.userId}, ${input.clientId}, ${input.method}, ${descriptorName},
          ${shape}, ${operationId}, ${input.inputDigest}, ${input.verificationCost}, ${budgetKind},
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
        AND (status <> 'refused' OR safe_outcome_code IS DISTINCT FROM 'abandoned_before_effect')
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

  async claimRunning(input: { invocationId: string; now: Date }): Promise<OperatorMcpInvocationRecord | null> {
    const claimed = await sql<OperatorMcpInvocationRow>`
      UPDATE operator_mcp_invocations
      SET status = 'running'
      WHERE id = ${input.invocationId} AND status = 'admitted'
      RETURNING ${invocationColumns}
    `.execute(this.db);
    return claimed.rows[0] ? mapInvocation(claimed.rows[0]) : null;
  }

  async recordOutcome(input: {
    invocationId: string;
    status: "completed" | "refused" | "failed";
    safeOutcomeCode: string;
    safeRejectionDetails?: readonly import("../../modules/operatorCopilot/invalidArgumentDetails.js").OperatorMcpRejectionDetail[];
    resultReference?: string | null;
    now: Date;
  }): Promise<OperatorMcpInvocationRecord | null> {
    const safeOutcomeCode = boundedString(input.safeOutcomeCode, "safe outcome code", 128);
    if (!safeOutcomeCode) throw new Error("safe outcome code is required");
    const resultReference = boundedString(input.resultReference, "result reference", 512);
    const safeRejectionDetails = boundRejectionDetails(input.safeRejectionDetails);
    const updated = await sql<OperatorMcpInvocationRow>`
      UPDATE operator_mcp_invocations
      SET status = ${input.status}, safe_outcome_code = ${safeOutcomeCode}, safe_rejection_details = ${JSON.stringify(safeRejectionDetails)}::jsonb,
          result_reference = ${resultReference}, completed_at = ${input.now}
      WHERE id = ${input.invocationId}
        AND (
          status IN ('admitted', 'running')
          OR (status = 'failed' AND ${input.status} = 'completed' AND ${safeOutcomeCode} = 'completed')
        )
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
    inputDigest: string; verificationCost: number; budgetKind: OperatorMcpBudgetKind; now: Date;
  }): Promise<
    | { status: "prepared" | "replay"; invocation: OperatorMcpInvocationRecord }
    | { status: "conflict" }
    | ({ status: "budget_exhausted" } & OperatorMcpBudgetRetry)
  > {
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
            AND (status <> 'refused' OR safe_outcome_code IS DISTINCT FROM 'abandoned_before_effect')
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
          WHERE grant_id = ${current.grantId} AND budget_kind = ${input.budgetKind} AND id <> ${input.invocationId}
            AND budget_reserved_at IS NOT NULL
            AND budget_reserved_at >= (${input.now}::timestamptz - INTERVAL '60 seconds')
        `.execute(trx);
        if (Number(spent.rows[0]?.units ?? 0) + input.verificationCost > this.budgetLimit(input.budgetKind)) {
          return {
            status: "budget_exhausted" as const,
            ...await budgetRetryInfo(trx, { grantId: current.grantId, kind: input.budgetKind, now: input.now, excludeInvocationId: input.invocationId }),
          };
        }
      }
      const updated = await sql<OperatorMcpInvocationRow>`
        UPDATE operator_mcp_invocations SET operation_id = ${input.operationId}, shape = ${input.shape},
          input_digest = ${input.inputDigest}, verification_cost = ${input.verificationCost}, budget_kind = ${input.budgetKind},
          budget_reserved_at = ${input.verificationCost > 0 ? input.now : null}
        WHERE id = ${input.invocationId} AND status = 'admitted'
        RETURNING ${invocationColumns}
      `.execute(trx);
      if (!updated.rows[0]) return { status: "conflict" as const };
      return { status: "prepared" as const, invocation: mapInvocation(updated.rows[0]) };
    });
  }
}
