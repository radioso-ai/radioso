import type { Db } from "../../../shared/infra/kysely/types.js";

export interface SlackConversationReplyLinkRecord {
  slackKey: string;
  installationId: string;
}

export interface SlackConversationLinkLookupPort {
  findConversationLinkByConversationId(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<SlackConversationReplyLinkRecord | null>;
}

export class PostgresSlackConversationLinkLookup implements SlackConversationLinkLookupPort {
  constructor(private readonly db: Db) {}

  async findConversationLinkByConversationId(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<SlackConversationReplyLinkRecord | null> {
    const row = await this.db
      .selectFrom("slack_conversation_links")
      .select(["slack_key", "installation_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    return row ? {
      slackKey: row.slack_key,
      installationId: row.installation_id,
    } : null;
  }
}
