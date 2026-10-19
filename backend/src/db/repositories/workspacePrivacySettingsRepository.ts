import type { Kysely } from "kysely";

import type {
  ConversationRetentionPolicies,
  PrivacySettings,
  PrivacySettingsStore,
  WorkspaceConversationRetention,
} from "../../modules/privacy/public.js";
import { anyOf, currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * A workspace's privacy settings, kept on its `workspaces` row: today the conversation retention
 * window. Also the retention sweep's list of the workspaces that set one.
 */
export class WorkspacePrivacySettingsRepository implements PrivacySettingsStore, ConversationRetentionPolicies {
  constructor(private readonly db: Kysely<DB>) {}

  async read(workspaceId: string): Promise<{ accountId: string; settings: PrivacySettings } | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(["account_id", "conversation_retention_days"])
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return row ? { accountId: row.account_id, settings: { conversationRetentionDays: row.conversation_retention_days } } : null;
  }

  async write(input: {
    workspaceId: string;
    settings: PrivacySettings;
    expected?: PrivacySettings;
  }): ReturnType<PrivacySettingsStore["write"]> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("workspaces")
        .select(["account_id", "conversation_retention_days"])
        .where("id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      const previous = { conversationRetentionDays: current.conversation_retention_days };
      if (input.expected && input.expected.conversationRetentionDays !== previous.conversationRetentionDays) {
        return { status: "changed" as const };
      }
      await trx
        .updateTable("workspaces")
        .set({ conversation_retention_days: input.settings.conversationRetentionDays, updated_at: currentTimestamp() })
        .where("id", "=", input.workspaceId)
        .execute();
      return { status: "written" as const, accountId: current.account_id, previous };
    });
  }

  async listConversationRetention(): Promise<WorkspaceConversationRetention[]> {
    const rows = await this.db
      .selectFrom("workspaces")
      .select(["id", "account_id", "conversation_retention_days"])
      .where("conversation_retention_days", "is not", null)
      .orderBy("conversation_retention_swept_at", (order) => order.asc().nullsFirst())
      .orderBy("id")
      .execute();
    return rows.flatMap((row) => row.conversation_retention_days === null
      ? []
      : [{ workspaceId: row.id, accountId: row.account_id, retentionDays: row.conversation_retention_days }]);
  }

  /** Leaves the workspace's own `updated_at` alone: a sweep reaching it changes none of its settings. */
  async recordSwept(workspaceIds: readonly string[], at: Date): Promise<void> {
    if (workspaceIds.length === 0) return;
    await this.db
      .updateTable("workspaces")
      .set({ conversation_retention_swept_at: at })
      .where((eb) => anyOf(eb.ref("id"), workspaceIds, "uuid[]"))
      .execute();
  }
}
