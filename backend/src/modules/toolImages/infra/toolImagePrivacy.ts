import type { Kysely } from "kysely";

import type { BackgroundJobWriter } from "../../../shared/background-jobs/index.js";
import type { ConversationDataEraser, ConversationErasureScope } from "../../../shared/domain/conversationDataErasure.js";
import type { ConversationDataRetentionRule } from "../../../shared/domain/conversationDataRetention.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { TOOL_IMAGE_LIMITS } from "../domain.js";
import { handOffToolImageObjects } from "../services/toolImageJobs.js";
import { toolImageObjectsOf } from "./toolImageRepository.js";

const OBJECT_COLUMNS = ["renditions"] as const;

/**
 * A conversation's tool images, as the conversation goes: the rows are deleted here, while the
 * conversations still exist, and their stored objects are handed to the deletion job in the same
 * transaction, which deletes them once the erasure commits. A whole workspace's erasure removes
 * nothing here: its rows cascade with it, and its storage purge takes every object under it.
 *
 * The data-subject export carries each card the conversation's replies showed, with its title,
 * link and picture's id, from the messages; the copies themselves are a third party's pictures and
 * stay out of it.
 */
export class ToolImageEraser implements ConversationDataEraser {
  readonly owner = "tool-images";

  constructor(
    private readonly trx: Db,
    private readonly jobs: Pick<BackgroundJobWriter, "insert">,
  ) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "workspace" || scope.conversationIds.length === 0) return 0;
    const rows = await this.trx
      .deleteFrom("conversation_tool_images")
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .returning(OBJECT_COLUMNS)
      .execute();
    await handOffToolImageObjects(this.jobs, this.trx, rows.flatMap(toolImageObjectsOf));
    return rows.length;
  }
}

/**
 * Tool images no message carries, a day after their row was written: one whose message was
 * deleted on its own, or one Test Chat showed. Each batch deletes its rows and hands their objects to the deletion job
 * in one transaction.
 */
export class UnboundToolImageRetention implements ConversationDataRetentionRule {
  readonly table = "conversation_tool_images";

  constructor(
    private readonly db: Kysely<DB>,
    private readonly jobsIn: (trx: Db) => Pick<BackgroundJobWriter, "insert">,
  ) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const cutoff = new Date(input.now.getTime() - TOOL_IMAGE_LIMITS.unboundLifetimeMs);
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .deleteFrom("conversation_tool_images")
        .where("id", "in", (eb) => eb
          .selectFrom("conversation_tool_images as image")
          .select("image.id")
          .where("image.message_id", "is", null)
          .where("image.created_at", "<", cutoff)
          .orderBy("image.created_at")
          .limit(input.limit)
          .forUpdate()
          .skipLocked())
        .returning(OBJECT_COLUMNS)
        .execute();
      await handOffToolImageObjects(this.jobsIn(trx), trx, rows.flatMap(toolImageObjectsOf));
      return rows.length;
    });
  }
}
