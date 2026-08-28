import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import { nowMinusSeconds } from "../../shared/infra/kysely/sqlHelpers.js";
import type { CopilotConversation, CopilotMessage, CopilotProposal, CopilotProposalApplyClaimGuard, CopilotProposalCard, CopilotProposalClaim, CopilotProposalEvidence, CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";
import { copilotProposalTargetTypes, summarizeProposalEvidence } from "../../modules/operatorCopilot/public.js";

interface CopilotConversationRow { id: string; workspace_id: string; operator_user_id: string; title: string | null; status: string; created_at: Date; updated_at: Date; }
interface CopilotMessageRow { id: string; conversation_id: string; role: string; content: string; outcome: string | null; activity: unknown; created_at: Date; }
interface CopilotProposalRow { id: string; workspace_id: string; operator_user_id: string; conversation_id: string; message_id: string | null; target_type: string; target_ref: unknown; payload: unknown; version_token: string; evidence: unknown; status: string; failure_reason: string | null; applied_ref: unknown | null; created_at: Date; updated_at: Date; }
const conversationColumns = ["id", "workspace_id", "operator_user_id", "title", "status", "created_at", "updated_at"] as const;
const messageColumns = ["id", "conversation_id", "role", "content", "outcome", "activity", "created_at"] as const;
const proposalColumns = ["id", "workspace_id", "operator_user_id", "conversation_id", "message_id", "target_type", "target_ref", "payload", "version_token", "evidence", "status", "failure_reason", "applied_ref", "created_at", "updated_at"] as const;
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
const mapProposal = (row: CopilotProposalRow): CopilotProposal => ({ id: row.id, workspaceId: row.workspace_id, operatorUserId: row.operator_user_id, conversationId: row.conversation_id, messageId: row.message_id, targetType: narrowTargetType(row.target_type), targetRef: row.target_ref, payload: row.payload, versionToken: row.version_token, evidence: narrowEvidence(row.evidence), status: narrowProposalStatus(row.status), reason: row.failure_reason, appliedRef: row.applied_ref, createdAt: row.created_at, updatedAt: row.updated_at });
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
  const card = { id: proposal.id, targetType: proposal.targetType, targetLabel, summary: textValue(payload.rationale, targetLabel), status: proposal.status, reason: proposal.reason ?? null };
  return proposal.evidence ? { ...card, evidence: summarizeProposalEvidence(proposal.evidence) } : card;
};
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const textValue = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;

export class CopilotRepository implements CopilotRepositoryPort {
  constructor(private readonly db: Db) {}
  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> { const row = await this.db.insertInto("copilot_conversations").values({ id: randomUUID(), workspace_id: input.workspaceId, operator_user_id: input.operatorUserId, title: input.title }).returning(conversationColumns).executeTakeFirstOrThrow(); return mapConversation(row); }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> { const row = await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return row ? mapConversation(row) : null; }
  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> { return (await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).orderBy("updated_at", "desc").execute()).map(mapConversation); }
  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> { const result = await this.db.deleteFrom("copilot_conversations").where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return Number(result.numDeletedRows) > 0; }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> { const row = await this.db.insertInto("copilot_messages").values({ id: randomUUID(), conversation_id: input.conversationId, role: input.role, content: input.content, outcome: input.outcome ?? null, activity: input.activity ? JSON.stringify(input.activity) : null }).returning(messageColumns).executeTakeFirstOrThrow(); return mapMessage(row); }
  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> { const [messages, proposals] = await Promise.all([this.db.selectFrom("copilot_messages").select(messageColumns).where("conversation_id", "=", input.conversationId).orderBy("created_at", "asc").execute(), this.db.selectFrom("copilot_proposals").select(proposalColumns).where("conversation_id", "=", input.conversationId).where("message_id", "is not", null).orderBy("created_at", "asc").execute()]); const cardsByMessage = new Map<string, CopilotProposalCard[]>(); for (const proposal of proposals.map(mapProposal)) { if (proposal.messageId) cardsByMessage.set(proposal.messageId, [...(cardsByMessage.get(proposal.messageId) ?? []), presentProposalCard(proposal)]); } return messages.map((row) => { const message = mapMessage(row); const cards = cardsByMessage.get(message.id); return cards ? { ...message, proposals: cards } : message; }); }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> { const conversation = await this.findConversation(input); if (!conversation) return null; if (conversation.status === "running") return "running"; const row = await this.db.updateTable("copilot_conversations").set({ status: "running", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).where("status", "=", "idle").returning(conversationColumns).executeTakeFirst(); return row ? mapConversation(row) : "running"; }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> { await this.db.updateTable("copilot_conversations").set({ status: "idle", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).execute(); }
  async createProposal(input: Omit<CopilotProposal, "id" | "messageId" | "status" | "appliedRef" | "createdAt" | "updatedAt">): Promise<CopilotProposal> { const row = await this.db.insertInto("copilot_proposals").values({ id: randomUUID(), workspace_id: input.workspaceId, operator_user_id: input.operatorUserId, conversation_id: input.conversationId, target_type: input.targetType, target_ref: JSON.stringify(input.targetRef), payload: JSON.stringify(input.payload), version_token: input.versionToken, evidence: input.evidence ? JSON.stringify(input.evidence) : null }).returning(proposalColumns).executeTakeFirstOrThrow(); return mapProposal(row); }
  async findProposal(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotProposal | null> { const row = await this.db.selectFrom("copilot_proposals").select(proposalColumns).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return row ? mapProposal(row) : null; }
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
    return row ? mapProposal(row) : null;
  }

  /**
   * Claims a pending proposal for apply, refusing a concurrent claim while the current one is
   * still fresh. Also reclaims a claim older than `claimTtlSeconds` — a process that crashed
   * after claiming (before its write, or after it but before the outcome was recorded) leaves
   * exactly that: a claim timestamp nothing ever moves again. Recovery is the same relaxed
   * predicate for both crash windows; what makes a blind re-apply of an already-applied proposal
   * safe is the adapter's own version gate on the *target* row, not anything tracked here.
   *
   * `claimedAt` is a JS `Date` written as-is (not SQL `now()`), so it round-trips through
   * Postgres at the millisecond precision it started at — the exact value `updateProposalOutcome`
   * can later match against as a fencing token, with no truncation to reconcile.
   */
  async claimProposalApply(input: { id: string; workspaceId: string; operatorUserId: string; claimTtlSeconds: number }): Promise<CopilotProposalClaim | null> {
    const claimedAt = new Date();
    const row = await this.db.updateTable("copilot_proposals")
      .set({ apply_started_at: claimedAt, updated_at: claimedAt })
      .where("id", "=", input.id)
      .where("workspace_id", "=", input.workspaceId)
      .where("operator_user_id", "=", input.operatorUserId)
      .where("status", "=", "pending")
      .where((eb) => eb.or([eb("apply_started_at", "is", null), eb("apply_started_at", "<=", nowMinusSeconds(input.claimTtlSeconds))]))
      .returning(proposalColumns)
      .executeTakeFirst();
    return row ? { proposal: mapProposal(row), claimedAt } : null;
  }
}
