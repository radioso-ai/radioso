import type { Kysely } from "kysely";

import type { BackgroundJobWriter } from "../../../shared/background-jobs/index.js";
import type { ConversationDataEraser, ConversationErasureScope } from "../../../shared/domain/conversationDataErasure.js";
import type { ConversationDataRetentionRule } from "../../../shared/domain/conversationDataRetention.js";
import {
  exportTimestamp,
  type DataSubjectDataExporter,
  type DataSubjectExportRecord,
  type DataSubjectExportScope,
} from "../../../shared/domain/dataSubjectAccess.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import { VISITOR_IMAGE_LIMITS, type VisitorImageObject } from "../domain.js";
import { handOffVisitorImageObjects } from "../services/visitorImageObjectDeletion.js";

const OBJECT_COLUMNS = ["storage_bucket", "storage_object_path", "storage_generation"] as const;

const objectOf = (row: { storage_bucket: string; storage_object_path: string; storage_generation: string | null }): VisitorImageObject => ({
  bucket: row.storage_bucket,
  objectPath: row.storage_object_path,
  generation: row.storage_generation,
});

/**
 * A conversation's photos, as the conversation goes: the rows are deleted here, while the
 * conversations still exist, and their stored objects are handed to the deletion job in the same
 * transaction, which deletes them once the erasure commits. A whole workspace's erasure removes
 * nothing here: its rows cascade with it, and its storage purge takes every object under it.
 */
export class VisitorImageEraser implements ConversationDataEraser {
  readonly owner = "visitor-images";

  constructor(
    private readonly trx: Db,
    private readonly jobs: Pick<BackgroundJobWriter, "insert">,
  ) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "workspace" || scope.conversationIds.length === 0) return 0;
    const rows = await this.trx
      .deleteFrom("visitor_images")
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .returning(OBJECT_COLUMNS)
      .execute();
    await handOffVisitorImageObjects(this.jobs, this.trx, rows.map(objectOf));
    return rows.length;
  }
}

/**
 * Photos no message carries, 24 hours after their upload: one a visitor attached and never sent,
 * one whose turn stored no message, or one whose message a newer input replaced. Each batch
 * deletes its rows and hands their objects to the deletion job in one transaction. A photo a send
 * claimed within the window is left for that send to bind.
 */
export class UnboundVisitorImageRetention implements ConversationDataRetentionRule {
  readonly table = "visitor_images";

  constructor(
    private readonly db: Kysely<DB>,
    private readonly jobsIn: (trx: Db) => Pick<BackgroundJobWriter, "insert">,
  ) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const cutoff = new Date(input.now.getTime() - VISITOR_IMAGE_LIMITS.unboundLifetimeMs);
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .deleteFrom("visitor_images")
        .where("id", "in", (eb) => eb
          .selectFrom("visitor_images as image")
          .select("image.id")
          .where("image.message_id", "is", null)
          .where("image.created_at", "<", cutoff)
          .where(({ or, eb: cmp }) => or([cmp("image.claimed_at", "is", null), cmp("image.claimed_at", "<", cutoff)]))
          .orderBy("image.created_at")
          .limit(input.limit)
          .forUpdate()
          .skipLocked())
        .returning(OBJECT_COLUMNS)
        .execute();
      await handOffVisitorImageObjects(this.jobsIn(trx), trx, rows.map(objectOf));
      return rows.length;
    });
  }
}

/**
 * The export's `visitor_images` section: each photo sent in the subject's conversations, with
 * its size and what the agent's model read in it. The bytes stay out of the export; the operator
 * sees each photo in the conversation, and the reading is the text the conversation carried.
 */
export class VisitorImageExporter implements DataSubjectDataExporter {
  readonly section = "visitor_images";

  constructor(private readonly db: Db) {}

  async export(scope: DataSubjectExportScope): Promise<DataSubjectExportRecord[]> {
    if (scope.conversationIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("visitor_images")
      .select(["id", "conversation_id", "message_id", "byte_size", "width", "height", "reading_status", "reading", "created_at"])
      .where("workspace_id", "=", scope.workspaceId)
      .where((eb) => anyOf(eb.ref("conversation_id"), scope.conversationIds, "uuid[]"))
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => ({
      imageId: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      contentType: "image/jpeg",
      byteSize: row.byte_size,
      width: row.width,
      height: row.height,
      readingStatus: row.reading_status,
      reading: row.reading,
      uploadedAt: exportTimestamp(new Date(row.created_at)),
    }));
  }
}
