import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { Db } from "../../shared/infra/kysely/types.js";
import { nowMinusSeconds } from "../../shared/infra/kysely/sqlHelpers.js";
import type { CopilotConversation, CopilotMcpProposalRecoveryPort, CopilotMessage, CopilotProposal, CopilotProposalApplyClaimGuard, CopilotProposalCard, CopilotProposalClaim, CopilotProposalDraft, CopilotProposalEvidence, CopilotRepositoryPort, CopilotRetentionPort } from "../../modules/operatorCopilot/public.js";
import { copilotProposalTargetTypes, summarizeProposalEvidence } from "../../modules/operatorCopilot/public.js";

interface CopilotConversationRow { id: string; workspace_id: string; operator_user_id: string; title: string | null; status: string; created_at: Date; updated_at: Date; }
interface CopilotMessageRow { id: string; conversation_id: string; role: string; content: string; outcome: string | null; activity: unknown; created_at: Date; }
interface CopilotProposalRow { id: string; workspace_id: string; operator_user_id: string; conversation_id: string | null; operator_mcp_invocation_id: string | null; message_id: string | null; target_type: string; target_ref: unknown; payload: unknown; version_token: string; evidence: unknown; status: string; failure_reason: string | null; applied_ref: unknown | null; created_at: Date; updated_at: Date; }
interface RecoverableOperatorMcpInvocationRow { id: string; grant_id: string; workspace_id: string; user_id: string; operation_id: string | null; descriptor_name: string | null; input_digest: string; proof_consumed_at: Date | null; status: string; }
const conversationColumns = ["id", "workspace_id", "operator_user_id", "title", "status", "created_at", "updated_at"] as const;
const messageColumns = ["id", "conversation_id", "role", "content", "outcome", "activity", "created_at"] as const;
const proposalColumns = ["id", "workspace_id", "operator_user_id", "conversation_id", "operator_mcp_invocation_id", "message_id", "target_type", "target_ref", "payload", "version_token", "evidence", "status", "failure_reason", "applied_ref", "created_at", "updated_at"] as const;
const narrowStatus = (status: string): CopilotConversation["status"] => (status === "running" ? "running" : "idle");
const narrowOutcome = (outcome: string | null): CopilotMessage["outcome"] | undefined =>
  outcome === "completed" || outcome === "budget_exhausted" || outcome === "failed" ? outcome : undefined;
const mapConversation = (row: CopilotConversationRow): CopilotConversation => ({ id: row.id, workspaceId: row.workspace_id, operatorUserId: row.operator_user_id, title: row.title, status: narrowStatus(row.status), createdAt: row.created_at, updatedAt: row.updated_at });
const mapMessage = (row: CopilotMessageRow): CopilotMessage => ({ id: row.id, conversationId: row.conversation_id, role: row.role === "copilot" ? "copilot" : "operator", content: row.content, ...(narrowOutcome(row.outcome) ? { outcome: narrowOutcome(row.outcome) } : {}), ...(Array.isArray(row.activity) ? { activity: row.activity as CopilotMessage["activity"] } : {}), createdAt: row.created_at });
const narrowTargetType = (targetType: string): CopilotProposal["targetType"] => {
  if ((copilotProposalTargetTypes as ReadonlyArray<string>).includes(targetType)) return targetType as CopilotProposal["targetType"];
  throw new Error(`Unknown copilot proposal target type: ${targetType}`);
};
const narrowProposalStatus = (status: string): CopilotProposal["status"] => status === "applied" || status === "dismissed" || status === "failed" || status === "stale" ? status : "pending";
const mapProposal = (row: CopilotProposalRow): CopilotProposal => ({ id: row.id, workspaceId: row.workspace_id, operatorUserId: row.operator_user_id, origin: row.conversation_id ? { type: "conversation", conversationId: row.conversation_id } : { type: "operator_mcp_invocation", invocationId: row.operator_mcp_invocation_id! }, conversationId: row.conversation_id, operatorMcpInvocationId: row.operator_mcp_invocation_id, messageId: row.message_id, targetType: narrowTargetType(row.target_type), targetRef: row.target_ref, payload: row.payload, versionToken: row.version_token, evidence: narrowEvidence(row.evidence), status: narrowProposalStatus(row.status), reason: row.failure_reason, appliedRef: row.applied_ref, createdAt: row.created_at, updatedAt: row.updated_at });
/** Stored as JSONB, so a row written before evidence existed reads as unmeasured, not as empty. */
const narrowEvidence = (value: unknown): CopilotProposalEvidence | null => {
  const record = asRecord(value);
  return Array.isArray(record.cases) ? { cases: record.cases as CopilotProposalEvidence["cases"] } : null;
};
export const presentProposalCard = (proposal: CopilotProposal): CopilotProposalCard => {
  const targetRef = asRecord(proposal.targetRef);
  const payload = asRecord(proposal.payload);
  // agent_setting is the only target type with no drafted name of its own - it targets an existing
  // setting key instead. Every other target type (present or future) proposes a named thing, so
  // this reads as "not agent_setting" rather than an OR-chain a new target type could miss.
  const targetLabel = proposal.targetType !== "agent_setting" ? textValue(payload.name, "") : textValue(targetRef.settingKey, "");
  // A payload states its own irreversibility, so a reloaded card warns about deletion without the
  // reader having to recognise each target type's word for it - the pairing that silently dropped
  // the warning when document removal arrived. The directive clause reads rows written before the
  // flag existed; every proposal drafted since carries `removesTarget`.
  const removal = payload.removesTarget === true || (proposal.targetType === "directive" && payload.op === "remove");
  // Read from the payload for the same reason as removal: the draft decided reach against the
  // settings it was made from, and a reader re-deriving it from field names would have to know
  // which of them mean reach.
  const reach = payload.changesReach === true;
  const card = { id: proposal.id, targetType: proposal.targetType, targetLabel, summary: textValue(payload.summary, textValue(payload.rationale, targetLabel)), status: proposal.status, reason: proposal.reason ?? null, ...(removal ? { removal: true as const } : {}), ...(reach ? { reach: true as const } : {}) };
  return proposal.evidence ? { ...card, evidence: summarizeProposalEvidence(proposal.evidence) } : card;
};
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textValue = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;

export class CopilotRepository implements CopilotRepositoryPort, CopilotRetentionPort, CopilotMcpProposalRecoveryPort {
  constructor(private readonly db: Db) {}
  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> { const row = await this.db.insertInto("copilot_conversations").values({ id: randomUUID(), workspace_id: input.workspaceId, operator_user_id: input.operatorUserId, title: input.title }).returning(conversationColumns).executeTakeFirstOrThrow(); return mapConversation(row); }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> { const row = await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return row ? mapConversation(row) : null; }
  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> { return (await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).orderBy("updated_at", "desc").execute()).map(mapConversation); }
  /**
   * Deletes by id from a bounded, ordered subquery rather than by predicate: an unqualified
   * `DELETE ... WHERE updated_at < cutoff` locks every matching row in one statement, and the
   * first sweep after this ships is the largest one the deployment will ever run.
   *
   * The cutoff is repeated on the outer delete, not left to the subquery. The subquery chooses
   * which rows this batch considers; the predicate is the policy, and Postgres rechecks the outer
   * qual against the current row version when a concurrent transaction updated it. Without the
   * repeat, an operator who resumed a long-idle conversation in the moment between the subquery's
   * snapshot and the delete acquiring its row lock would have it deleted mid-turn, taking its
   * messages and proposals with it.
   */
  async deleteConversationsUpdatedBefore(input: { cutoff: Date; limit: number }): Promise<number> {
    const result = await this.db
      .deleteFrom("copilot_conversations")
      .where("updated_at", "<", input.cutoff)
      .where("id", "in", (eb) => eb
        .selectFrom("copilot_conversations")
        .select("id")
        .where("updated_at", "<", input.cutoff)
        .orderBy("updated_at", "asc")
        .limit(input.limit))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
  async deleteExpiredOperatorMcpRecords(input: { now: Date; limit: number }): Promise<number> {
    if (!Number.isInteger(input.limit) || input.limit < 1) throw new Error("retention limit must be a positive integer");
    return this.db.transaction().execute(async (trx) => {
      const selected = await sql<{ id: string }>`
        SELECT id
        FROM operator_mcp_invocations
        WHERE retained_until < ${input.now}
        ORDER BY retained_until ASC, id ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      `.execute(trx);
      const ids = selected.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      const idList = sql.join(ids.map((id) => sql`${id}`));

      await sql`
        UPDATE copilot_proposals
        SET status = 'stale', updated_at = ${input.now}
        WHERE operator_mcp_invocation_id IN (${idList}) AND status = 'pending'
      `.execute(trx);
      await sql`
        DELETE FROM copilot_replay_evidence AS evidence
        WHERE evidence.operator_mcp_invocation_id IN (${idList})
          AND (
            evidence.proposal_id IS NULL
            OR EXISTS (
              SELECT 1 FROM copilot_proposals AS proposal
              WHERE proposal.id = evidence.proposal_id AND proposal.status <> 'pending'
            )
          )
      `.execute(trx);
      await sql`
        DELETE FROM copilot_proposals
        WHERE operator_mcp_invocation_id IN (${idList}) AND status <> 'pending'
      `.execute(trx);
      const deleted = await sql<{ id: string }>`
        DELETE FROM operator_mcp_invocations AS invocation
        WHERE invocation.id IN (${idList})
          AND NOT EXISTS (
            SELECT 1 FROM copilot_proposals AS proposal
            WHERE proposal.operator_mcp_invocation_id = invocation.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM copilot_replay_evidence AS evidence
            WHERE evidence.operator_mcp_invocation_id = invocation.id
          )
        RETURNING invocation.id
      `.execute(trx);
      return deleted.rows.length;
    });
  }
  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> { const result = await this.db.deleteFrom("copilot_conversations").where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return Number(result.numDeletedRows) > 0; }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> { const row = await this.db.insertInto("copilot_messages").values({ id: randomUUID(), conversation_id: input.conversationId, role: input.role, content: input.content, outcome: input.outcome ?? null, activity: input.activity ? JSON.stringify(input.activity) : null }).returning(messageColumns).executeTakeFirstOrThrow(); return mapMessage(row); }
  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> { const [messages, proposals] = await Promise.all([this.db.selectFrom("copilot_messages").select(messageColumns).where("conversation_id", "=", input.conversationId).orderBy("created_at", "asc").execute(), this.db.selectFrom("copilot_proposals").select(proposalColumns).where("conversation_id", "=", input.conversationId).where("message_id", "is not", null).orderBy("created_at", "asc").execute()]); const cardsByMessage = new Map<string, CopilotProposalCard[]>(); for (const proposal of proposals.map(mapProposal)) { if (proposal.messageId) cardsByMessage.set(proposal.messageId, [...(cardsByMessage.get(proposal.messageId) ?? []), presentProposalCard(proposal)]); } return messages.map((row) => { const message = mapMessage(row); const cards = cardsByMessage.get(message.id); return cards ? { ...message, proposals: cards } : message; }); }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> { const conversation = await this.findConversation(input); if (!conversation) return null; if (conversation.status === "running") return "running"; const row = await this.db.updateTable("copilot_conversations").set({ status: "running", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).where("status", "=", "idle").returning(conversationColumns).executeTakeFirst(); return row ? mapConversation(row) : "running"; }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> { await this.db.updateTable("copilot_conversations").set({ status: "idle", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).execute(); }
  async createProposal(input: CopilotProposalDraft): Promise<CopilotProposal> {
    const origin = input.origin ?? { type: "conversation" as const, conversationId: input.conversationId };
    const id = randomUUID();
    if (origin.type === "operator_mcp_invocation") {
      const result = await sql<CopilotProposalRow>`
        WITH current_authorization AS (
          SELECT invocation.id
          FROM operator_mcp_invocations invocation
          JOIN operator_mcp_grants oauth_grant ON oauth_grant.id = invocation.grant_id
          JOIN operator_mcp_access_credentials credential ON credential.id = invocation.credential_id
          JOIN operator_mcp_clients client ON client.id = oauth_grant.client_id
          JOIN account_memberships membership ON membership.id = oauth_grant.membership_id
          JOIN users account_user ON account_user.id = oauth_grant.user_id
          JOIN operator_mcp_deployment_credential_state deployment ON deployment.resource = oauth_grant.resource
          WHERE invocation.id = ${origin.invocationId}
            AND invocation.workspace_id = ${input.workspaceId}
            AND invocation.user_id = ${input.operatorUserId}
            AND invocation.status = 'running'
            AND invocation.shape = 'propose'
            AND oauth_grant.status = 'active'
            AND oauth_grant.version = invocation.grant_version
            AND 'operator:propose' = ANY(oauth_grant.tool_scopes)
            AND membership.status = 'active'
            AND membership.id = oauth_grant.membership_id
            AND account_user.disabled_at IS NULL
            AND client.status = 'active'
            AND client.version = oauth_grant.client_version
            AND credential.grant_id = oauth_grant.id
            AND credential.issued_grant_version = oauth_grant.version
            AND credential.issued_client_version = oauth_grant.client_version
            AND credential.issued_client_metadata_snapshot_id = oauth_grant.client_metadata_snapshot_id
            AND credential.issued_credential_epoch = oauth_grant.credential_epoch
            AND credential.expires_at > NOW()
            AND deployment.credential_epoch = oauth_grant.credential_epoch
          FOR UPDATE OF invocation, oauth_grant, credential, client, membership, account_user, deployment
        )
        INSERT INTO copilot_proposals (
          id, workspace_id, operator_user_id, conversation_id, operator_mcp_invocation_id,
          target_type, target_ref, payload, version_token, evidence
        )
        SELECT ${id}, ${input.workspaceId}, ${input.operatorUserId}, NULL, ${origin.invocationId},
          ${input.targetType}, ${JSON.stringify(input.targetRef)}::jsonb, ${JSON.stringify(input.payload)}::jsonb,
          ${input.versionToken}, ${input.evidence ? JSON.stringify(input.evidence) : null}::jsonb
        FROM current_authorization
        RETURNING *
      `.execute(this.db);
      const row = result.rows[0];
      if (!row) throw new Error("Operator MCP proposal authorization is no longer current");
      return mapProposal(row);
    }
    const row = await this.db.insertInto("copilot_proposals").values({
      id,
      workspace_id: input.workspaceId,
      operator_user_id: input.operatorUserId,
      conversation_id: origin.conversationId,
      operator_mcp_invocation_id: null,
      target_type: input.targetType,
      target_ref: JSON.stringify(input.targetRef),
      payload: JSON.stringify(input.payload),
      version_token: input.versionToken,
      evidence: input.evidence ? JSON.stringify(input.evidence) : null,
    }).returning(proposalColumns).executeTakeFirstOrThrow();
    return mapProposal(row as CopilotProposalRow);
  }
  async recoverOperatorMcpProposal(input: Parameters<CopilotMcpProposalRecoveryPort["recoverOperatorMcpProposal"]>[0]): ReturnType<CopilotMcpProposalRecoveryPort["recoverOperatorMcpProposal"]> {
    return this.db.transaction().execute(async (trx) => {
      // createProposal locks this same invocation before inserting. Taking that lock first makes
      // "proposal exists" versus "safe to release" an atomic decision across backend replicas.
      const selected = await sql<RecoverableOperatorMcpInvocationRow>`
        SELECT id, grant_id, workspace_id, user_id, operation_id, descriptor_name, input_digest,
          proof_consumed_at, status
        FROM operator_mcp_invocations
        WHERE id = ${input.invocationId}
        FOR UPDATE
      `.execute(trx);
      const invocation = selected.rows[0];
      if (!invocation
        || invocation.grant_id !== input.grantId
        || invocation.workspace_id !== input.workspaceId
        || invocation.user_id !== input.operatorUserId
        || invocation.operation_id !== input.operationId
        || invocation.descriptor_name !== input.descriptorName
        || invocation.input_digest !== input.inputDigest) {
        return { status: "conflict" as const };
      }

      const proposals = await sql<CopilotProposalRow>`
        SELECT ${sql.join(proposalColumns.map((column) => sql.ref(column)))}
        FROM copilot_proposals
        WHERE operator_mcp_invocation_id = ${input.invocationId}
          AND workspace_id = ${input.workspaceId}
          AND operator_user_id = ${input.operatorUserId}
        LIMIT 2
      `.execute(trx);
      if (proposals.rows.length === 1) {
        return { status: "recovered" as const, proposal: mapProposal(proposals.rows[0]!) };
      }
      if (proposals.rows.length > 1) return { status: "conflict" as const };
      if (invocation.status !== "admitted" && invocation.status !== "running") {
        return { status: "retry_prepare" as const };
      }
      if (!invocation.proof_consumed_at) return { status: "conflict" as const };
      if (new Date(invocation.proof_consumed_at).getTime() > input.staleBefore.getTime()) {
        return { status: "in_progress" as const };
      }

      await sql`
        UPDATE operator_mcp_invocations
        SET status = 'refused', safe_outcome_code = 'abandoned_before_effect',
          budget_reserved_at = NULL, completed_at = ${input.now}
        WHERE id = ${input.invocationId} AND status IN ('admitted', 'running')
      `.execute(trx);
      return { status: "retry_prepare" as const };
    });
  }
  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> { const row = await this.db.selectFrom("copilot_proposals").select(proposalColumns).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return row ? mapProposal(row) : null; }
  async findProposalWorkspace(input: { id: string; accountId: string; operatorUserId: string }): Promise<string | null> {
    const row = await this.db
      .selectFrom("copilot_proposals as proposal")
      .innerJoin("workspaces as workspace", "workspace.id", "proposal.workspace_id")
      .select("proposal.workspace_id as workspace_id")
      .where("proposal.id", "=", input.id)
      .where("proposal.operator_user_id", "=", input.operatorUserId)
      .where("workspace.account_id", "=", input.accountId)
      .executeTakeFirst();
    return row?.workspace_id ?? null;
  }
  async attachProposalsToMessage(input: { proposalIds: ReadonlyArray<string>; messageId: string; conversationId: string }): Promise<void> { if (input.proposalIds.length === 0) return; await this.db.updateTable("copilot_proposals").set({ message_id: input.messageId, updated_at: new Date() }).where("id", "in", input.proposalIds).where("conversation_id", "=", input.conversationId).execute(); }
  async updateProposalOutcome(input: { id: string; workspaceId: string; operatorUserId: string; status: CopilotProposal["status"]; appliedRef?: unknown | null; reason?: string | null; applyClaimGuard: CopilotProposalApplyClaimGuard }): Promise<CopilotProposal | null> {
    let query = this.db.updateTable("copilot_proposals")
      .set({ status: input.status, failure_reason: input.reason ?? null, applied_ref: input.appliedRef === undefined ? null : JSON.stringify(input.appliedRef), updated_at: new Date() })
      .where("id", "=", input.id)
      .where("workspace_id", "=", input.workspaceId)
      .where("operator_user_id", "=", input.operatorUserId)
      .where("status", "=", "pending");
    // `held` finalizes only the exact claim it was handed — a claim superseded by a later
    // recovery reclaim no longer matches, so a crashed writer's late finalize is a no-op rather
    // than a write on behalf of whichever attempt now holds the row. `free` (dismiss) must not
    // race an active apply, but a claim old enough to count as abandoned must not block it either.
    const applyClaimGuard = input.applyClaimGuard;
    query = applyClaimGuard.state === "held"
      ? query.where("apply_started_at", "=", applyClaimGuard.claimedAt)
      : query.where((eb) => eb.or([eb("apply_started_at", "is", null), eb("apply_started_at", "<=", nowMinusSeconds(applyClaimGuard.claimTtlSeconds))]));
    const row = await query.returning(proposalColumns).executeTakeFirst();
    if (!row) return null;
    // Resolving a proposal — dismissing it, or finalizing an apply — is activity on its
    // conversation, and retention deletes by the conversation's own last-activity date. Without
    // this, an operator who cleared a stale proposal today would watch the thread it belongs to
    // disappear on the next sweep. Claiming an apply re-dates it too, so an apply lands here
    // already fresh and this is a harmless second touch.
    if (row.conversation_id) {
      await this.db.updateTable("copilot_conversations")
        .set({ updated_at: new Date() })
        .where("id", "=", row.conversation_id)
        .execute();
    }
    return mapProposal(row);
  }

  /**
   * Claims a pending proposal for apply, refusing a concurrent claim while the current one is
   * still fresh. Also reclaims a claim older than `claimTtlSeconds` — a process that crashed
   * after claiming (before its write, or after it but before the outcome was recorded) leaves
   * exactly that: a claim timestamp nothing ever moves again. Recovery is the same relaxed
   * predicate for both crash windows, and `previousAttemptStartedAt` is what tells them apart
   * afterwards: set, an earlier attempt reached at least as far as claiming, and the service
   * refuses to retry an effect whose adapter cannot recognise its own first attempt.
   *
   * The read is locking and in the same transaction as the claim, so the value reported is the one
   * this claim actually replaced rather than whatever the row held a round trip earlier.
   *
   * `claimedAt` is a JS `Date` written as-is (not SQL `now()`), so it round-trips through
   * Postgres at the millisecond precision it started at — the exact value `updateProposalOutcome`
   * can later match against as a fencing token, with no truncation to reconcile.
   */
  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string; claimTtlSeconds: number }): Promise<CopilotProposalClaim | null> {
    const claimedAt = new Date();
    return this.db.transaction().execute(async (trx) => {
      const previous = await trx.selectFrom("copilot_proposals")
        .select("apply_started_at")
        .where("id", "=", input.id)
        .where("workspace_id", "=", input.workspaceId)
        .where("operator_user_id", "=", input.operatorUserId)
        .forUpdate()
        .executeTakeFirst();
      const row = await trx.updateTable("copilot_proposals")
        .set({ apply_started_at: claimedAt, updated_at: claimedAt })
        .where("id", "=", input.id)
        .where("workspace_id", "=", input.workspaceId)
        .where("operator_user_id", "=", input.operatorUserId)
        .where("status", "=", "pending")
        .where((eb) => eb.or([eb("apply_started_at", "is", null), eb("apply_started_at", "<=", nowMinusSeconds(input.claimTtlSeconds))]))
        .returning(proposalColumns)
        .executeTakeFirst();
      if (!row) return null;
      // Applying is activity on the conversation, and re-dating it here is what keeps retention
      // from deleting the row mid-apply: the domain mutation happens after this transaction
      // commits, and the delete rechecks its cutoff against the current version of this row. In
      // the same transaction as the claim so the two cannot be observed apart.
      if (row.conversation_id) {
        await trx.updateTable("copilot_conversations")
          .set({ updated_at: claimedAt })
          .where("id", "=", row.conversation_id)
          .execute();
      }
      return { proposal: mapProposal(row), claimedAt, previousAttemptStartedAt: previous?.apply_started_at ?? null };
    });
  }

  /**
   * Clears only the exact claim `claimProposalApply` handed to this attempt, after a
   * pre-mutation authorization denial. Fenced the same way `updateProposalOutcome`'s `held`
   * guard is: a claim already superseded by a later TTL reclaim no longer matches, so a
   * crashed writer's late release cannot clear an unrelated, currently active claim.
   */
  async releaseProposalApplyClaim(input: { id: string; workspaceId: string; operatorUserId: string; claimedAt: Date }): Promise<boolean> {
    const row = await this.db.updateTable("copilot_proposals")
      .set({ apply_started_at: null, updated_at: new Date() })
      .where("id", "=", input.id)
      .where("workspace_id", "=", input.workspaceId)
      .where("operator_user_id", "=", input.operatorUserId)
      .where("status", "=", "pending")
      .where("apply_started_at", "=", input.claimedAt)
      .returning("id")
      .executeTakeFirst();
    return Boolean(row);
  }
}
