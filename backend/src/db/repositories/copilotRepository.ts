import { randomUUID } from "node:crypto";

import type { Db } from "../../shared/infra/kysely/types.js";
import type { CopilotConversation, CopilotMessage, CopilotRepositoryPort } from "../../modules/operatorCopilot/public.js";

interface CopilotConversationRow { id: string; workspace_id: string; operator_user_id: string; title: string | null; status: string; created_at: Date; updated_at: Date; }
interface CopilotMessageRow { id: string; conversation_id: string; role: string; content: string; outcome: string | null; activity: unknown; created_at: Date; }
const conversationColumns = ["id", "workspace_id", "operator_user_id", "title", "status", "created_at", "updated_at"] as const;
const messageColumns = ["id", "conversation_id", "role", "content", "outcome", "activity", "created_at"] as const;
const narrowStatus = (status: string): CopilotConversation["status"] => (status === "running" ? "running" : "idle");
const narrowOutcome = (outcome: string | null): CopilotMessage["outcome"] | undefined =>
  outcome === "completed" || outcome === "budget_exhausted" || outcome === "failed" ? outcome : undefined;
const mapConversation = (row: CopilotConversationRow): CopilotConversation => ({ id: row.id, workspaceId: row.workspace_id, operatorUserId: row.operator_user_id, title: row.title, status: narrowStatus(row.status), createdAt: row.created_at, updatedAt: row.updated_at });
const mapMessage = (row: CopilotMessageRow): CopilotMessage => ({ id: row.id, conversationId: row.conversation_id, role: row.role === "copilot" ? "copilot" : "operator", content: row.content, ...(narrowOutcome(row.outcome) ? { outcome: narrowOutcome(row.outcome) } : {}), ...(Array.isArray(row.activity) ? { activity: row.activity as CopilotMessage["activity"] } : {}), createdAt: row.created_at });

export class CopilotRepository implements CopilotRepositoryPort {
  constructor(private readonly db: Db) {}
  async createConversation(input: { workspaceId: string; operatorUserId: string; title: string | null }): Promise<CopilotConversation> { const row = await this.db.insertInto("copilot_conversations").values({ id: randomUUID(), workspace_id: input.workspaceId, operator_user_id: input.operatorUserId, title: input.title }).returning(conversationColumns).executeTakeFirstOrThrow(); return mapConversation(row); }
  async findConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | null> { const row = await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return row ? mapConversation(row) : null; }
  async listConversations(input: { workspaceId: string; operatorUserId: string }): Promise<ReadonlyArray<CopilotConversation>> { return (await this.db.selectFrom("copilot_conversations").select(conversationColumns).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).orderBy("updated_at", "desc").execute()).map(mapConversation); }
  async deleteConversation(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<boolean> { const result = await this.db.deleteFrom("copilot_conversations").where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).executeTakeFirst(); return Number(result.numDeletedRows) > 0; }
  async createMessage(input: Omit<CopilotMessage, "id" | "createdAt">): Promise<CopilotMessage> { const row = await this.db.insertInto("copilot_messages").values({ id: randomUUID(), conversation_id: input.conversationId, role: input.role, content: input.content, outcome: input.outcome ?? null, activity: input.activity ? JSON.stringify(input.activity) : null }).returning(messageColumns).executeTakeFirstOrThrow(); return mapMessage(row); }
  async listMessages(input: { conversationId: string }): Promise<ReadonlyArray<CopilotMessage>> { return (await this.db.selectFrom("copilot_messages").select(messageColumns).where("conversation_id", "=", input.conversationId).orderBy("created_at", "asc").execute()).map(mapMessage); }
  async acquireTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<CopilotConversation | "running" | null> { const conversation = await this.findConversation(input); if (!conversation) return null; if (conversation.status === "running") return "running"; const row = await this.db.updateTable("copilot_conversations").set({ status: "running", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).where("status", "=", "idle").returning(conversationColumns).executeTakeFirst(); return row ? mapConversation(row) : "running"; }
  async finishTurn(input: { id: string; workspaceId: string; operatorUserId: string }): Promise<void> { await this.db.updateTable("copilot_conversations").set({ status: "idle", updated_at: new Date() }).where("id", "=", input.id).where("workspace_id", "=", input.workspaceId).where("operator_user_id", "=", input.operatorUserId).execute(); }
}
