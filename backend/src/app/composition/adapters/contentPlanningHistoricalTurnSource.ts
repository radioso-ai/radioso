import type { ContentPlanHistoricalTurnSourcePort } from "../../../modules/contentPlanning/services/historicalTurnProjectionService.js";
import type { HistoricalConversationSourcePort } from "../../../modules/contentPlanning/services/observationSourceLoader.js";
import {
  MAX_HISTORICAL_CONTEXT_MESSAGES,
  type ObservationSourceMessage,
} from "../../../modules/contentPlanning/services/observationSourceResolver.js";
import { jsonbKeyText } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { JsonValue } from "../../../shared/infra/kysely/schema.js";
import type { Db } from "../../../shared/infra/kysely/types.js";

const asObject = (value: JsonValue | null): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export class PostgresContentPlanHistoricalTurnSource
implements ContentPlanHistoricalTurnSourcePort, HistoricalConversationSourcePort {
  constructor(private readonly db: Db) {}

  async load(input: Parameters<ContentPlanHistoricalTurnSourcePort["load"]>[0]) {
    const messages = await this.loadContext({
      workspaceId: input.workspaceId,
      conversationId: input.turn.conversationId,
      sourceUserMessageId: input.turn.userMessageId!,
      limit: MAX_HISTORICAL_CONTEXT_MESSAGES,
    });
    const audit = await this.db
      .selectFrom("audit_events")
      .select("metadata_json")
      .where("workspace_id", "=", input.workspaceId)
      .where("event_type", "=", "chat.answer")
      .where((eb) =>
        eb(jsonbKeyText(eb.ref("metadata_json"), "assistantMessageId"), "=", input.turn.assistantMessageId),
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();

    return {
      messages,
      legacyAuditMetadata: audit?.metadata_json ?? null,
    };
  }

  async loadContext(input: {
    workspaceId: string;
    conversationId: string;
    sourceUserMessageId: string;
    limit: number;
  }): Promise<ObservationSourceMessage[]> {
    const limit = Math.min(MAX_HISTORICAL_CONTEXT_MESSAGES, Math.max(1, input.limit));
    const source = await this.db
      .selectFrom("messages")
      .select("created_at")
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("id", "=", input.sourceUserMessageId)
      .where("role", "=", "user")
      .executeTakeFirst();
    if (!source) return [];
    const followingLimit = Math.min(3, limit - 1);
    const precedingLimit = limit - followingLimit;
    const preceding = await this.db
      .selectFrom("messages")
      .select(["id", "role", "content", "metadata_json"])
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("created_at", "<=", source.created_at)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(precedingLimit)
      .execute();
    const following = followingLimit > 0
      ? await this.db
        .selectFrom("messages")
        .select(["id", "role", "content", "metadata_json"])
      .where("workspace_id", "=", input.workspaceId)
        .where("conversation_id", "=", input.conversationId)
        .where("created_at", ">", source.created_at)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .limit(followingLimit)
        .execute()
      : [];
    return [...preceding.reverse(), ...following].map((message) => ({
        id: message.id,
        role: message.role as ObservationSourceMessage["role"],
        content: message.content,
        ...(asObject(message.metadata_json)
          ? { metadata: asObject(message.metadata_json)! }
          : {}),
      }));
  }
}
