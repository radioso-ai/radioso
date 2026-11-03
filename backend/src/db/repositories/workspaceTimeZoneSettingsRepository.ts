import type { Kysely } from "kysely";

import type { WorkspaceTimeZoneReader } from "../../modules/retrieval/public.js";
import type { TimeZoneSettings, TimeZoneSettingsStore } from "../../modules/settings/public.js";
import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../shared/infra/kysely/types.js";

/**
 * A workspace's time zone setting, kept on its `workspaces` row: the settings service's store, and
 * the reader chat and retrieval resolve a turn's "today" from.
 */
export class WorkspaceTimeZoneSettingsRepository implements TimeZoneSettingsStore, WorkspaceTimeZoneReader {
  constructor(private readonly db: Kysely<DB>) {}

  async readWorkspaceTimeZone(workspaceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select("time_zone")
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return row?.time_zone ?? null;
  }

  async read(workspaceId: string): Promise<{ accountId: string; settings: TimeZoneSettings } | null> {
    const row = await this.db
      .selectFrom("workspaces")
      .select(["account_id", "time_zone"])
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    return row ? { accountId: row.account_id, settings: { timeZone: row.time_zone } } : null;
  }

  async write(input: {
    workspaceId: string;
    settings: TimeZoneSettings;
    expected?: TimeZoneSettings;
  }): ReturnType<TimeZoneSettingsStore["write"]> {
    return this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("workspaces")
        .select(["account_id", "time_zone"])
        .where("id", "=", input.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { status: "not_found" as const };
      const previous = { timeZone: current.time_zone };
      if (input.expected && input.expected.timeZone !== previous.timeZone) {
        return { status: "changed" as const };
      }
      await trx
        .updateTable("workspaces")
        .set({ time_zone: input.settings.timeZone, updated_at: currentTimestamp() })
        .where("id", "=", input.workspaceId)
        .execute();
      return { status: "written" as const, accountId: current.account_id, previous };
    });
  }
}
