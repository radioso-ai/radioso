import type { DataSubjectConversation, DataSubjectConversationDirectory } from "../../modules/privacy/public.js";
import {
  exportJson,
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../shared/domain/dataSubjectAccess.js";
import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

/**
 * A data subject's conversations: the directory an operator reviews before exporting or erasing,
 * and the export's `conversations` section, each conversation with its transcript. Run it inside
 * the data subject read's transaction.
 */
export class DataSubjectConversationRepository implements DataSubjectConversationDirectory, DataSubjectDataExporter {
  readonly section = "conversations";

  constructor(private readonly db: Db) {}

  async list(input: { workspaceId: string; conversationIds: readonly string[] }): Promise<DataSubjectConversation[]> {
    if (input.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("conversations as c")
      .select((eb) => [
        "c.id",
        "c.source_channel",
        "c.title",
        "c.created_at",
        "c.updated_at",
        eb.selectFrom("messages as m").select((inner) => inner.fn.countAll<string>().as("count")).whereRef("m.conversation_id", "=", "c.id").as("message_count"),
      ])
      .where("c.workspace_id", "=", input.workspaceId)
      .where((eb) => anyOf(eb.ref("c.id"), input.conversationIds, "uuid[]"))
      .execute();
    return rows.map((row) => ({
      id: row.id,
      channel: row.source_channel,
      title: row.title,
      startedAt: row.created_at,
      lastActivityAt: row.updated_at,
      messageCount: Number(row.message_count ?? 0),
    }));
  }

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const conversations = await this.db
      .selectFrom("conversations")
      .select([
        "id",
        "source_channel",
        "source_origin",
        "title",
        "entry_page_url",
        "entry_referrer",
        "channel_context",
        "request_context",
        "created_at",
        "updated_at",
      ])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("id"), scope.conversationIds, "uuid[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const messages = await this.db
      .selectFrom("messages")
      .select(["id", "conversation_id", "role", "content", "created_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const transcripts = new Map<string, DataSubjectExportRecord[]>();
    for (const message of messages) {
      const transcript = transcripts.get(message.conversation_id) ?? [];
      transcript.push({ id: message.id, role: message.role, content: message.content, createdAt: exportTimestamp(message.created_at) });
      transcripts.set(message.conversation_id, transcript);
    }
    return conversations.map((conversation) => ({
      id: conversation.id,
      channel: conversation.source_channel,
      title: conversation.title,
      sourceOrigin: conversation.source_origin,
      entryPageUrl: conversation.entry_page_url,
      entryReferrer: conversation.entry_referrer,
      channelContext: exportJson(conversation.channel_context),
      requestContext: exportJson(conversation.request_context),
      startedAt: exportTimestamp(conversation.created_at),
      lastActivityAt: exportTimestamp(conversation.updated_at),
      messages: transcripts.get(conversation.id) ?? [],
    }));
  }
}

/**
 * The export's `answer_feedback` section: the ratings and comments the subject left on answers in
 * their conversations. A teammate's own feedback from the dashboard is the teammate's, not the
 * subject's, and stays out.
 */
export class AnswerFeedbackExporter implements DataSubjectDataExporter {
  readonly section = "answer_feedback";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("assistant_answer_feedback")
      .select(["conversation_id", "assistant_message_id", "value", "comment", "created_at", "updated_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where("actor_type", "!=", "authenticated_user")
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      conversationId: row.conversation_id,
      messageId: row.assistant_message_id,
      value: row.value,
      comment: row.comment,
      createdAt: exportTimestamp(row.created_at),
      updatedAt: exportTimestamp(row.updated_at),
    }));
  }
}
