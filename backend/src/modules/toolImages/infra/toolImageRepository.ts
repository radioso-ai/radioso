import type { Kysely } from "kysely";

import type { BackgroundJobRequest, BackgroundJobWriter } from "../../../shared/background-jobs/index.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import type { ToolImagePreviewRecorder, ToolImageRowWriter, ToolImageSource } from "../contracts/index.js";
import {
  TOOL_IMAGE_LIMITS,
  type ClaimedToolImage,
  type ToolImageCaptureOutcome,
  type ToolImageClaim,
  type ToolImageObject,
  type ToolImageRendition,
  type ToolImageStore,
} from "../domain.js";
import { handOffToolImageObjects, toolImageCaptureRequests } from "../services/toolImageJobs.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const renditionFrom = (value: unknown): ToolImageRendition | null => {
  if (!isRecord(value)) return null;
  const { bucket, objectPath, generation, width, height, sizeBytes } = value;
  return typeof bucket === "string" && typeof objectPath === "string"
    && typeof width === "number" && typeof height === "number" && typeof sizeBytes === "number"
    ? { bucket, objectPath, generation: typeof generation === "string" ? generation : null, width, height, sizeBytes }
    : null;
};

/** Every stored object a row names: its renditions. */
export const toolImageObjectsOf = (row: { renditions: unknown }): ToolImageObject[] =>
  (Array.isArray(row.renditions) ? row.renditions.map(renditionFrom) : [])
    .filter((rendition): rendition is ToolImageRendition => rendition !== null)
    .map(({ bucket, objectPath, generation }) => ({ bucket, objectPath, generation }));

const asObjects = (objects: readonly ToolImageObject[]): ToolImageObject[] =>
  objects.map(({ bucket, objectPath, generation }) => ({ bucket, objectPath, generation }));

/**
 * The `conversation_tool_images` rows. Every write that finishes a capture matches the claim's
 * generation (`claimed_at`), so a capture whose claim another one took over after the claim
 * timeout changes nothing it no longer owns. Objects are handed to the deletion job in the same
 * transaction that retires them, so none outlives its row unrecorded.
 */
export class PostgresToolImageStore implements ToolImageStore, ToolImageRowWriter {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly jobsIn: (trx: Db) => Pick<BackgroundJobWriter, "insert">,
  ) {}

  async record(
    transaction: Db,
    input: { workspaceId: string; conversationId: string; messageId: string; sources: readonly ToolImageSource[] },
  ): Promise<BackgroundJobRequest[]> {
    if (input.sources.length === 0) return [];
    await transaction
      .insertInto("conversation_tool_images")
      .values(input.sources.map((source) => ({
        id: source.imageId,
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        source_url: source.url,
      })))
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    return toolImageCaptureRequests(input.sources.map((source) => source.imageId));
  }

  /**
   * The pictures of a reply in a conversation no row stores, such as Test Chat's: written with no
   * conversation and no message, so the unbound sweep deletes them a day later.
   */
  async recordPreview(transaction: Db, input: Parameters<ToolImagePreviewRecorder["recordPreview"]>[0]): Promise<BackgroundJobRequest[]> {
    if (input.sources.length === 0) return [];
    await transaction
      .insertInto("conversation_tool_images")
      .values(input.sources.map((source) => ({ id: source.imageId, workspace_id: input.workspaceId, source_url: source.url })))
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
    return toolImageCaptureRequests(input.sources.map((source) => source.imageId));
  }

  async claim(imageId: string, now: Date): Promise<ToolImageClaim> {
    const staleBefore = new Date(now.getTime() - TOOL_IMAGE_LIMITS.claimTimeoutMs);
    const claimed = await this.db
      .updateTable("conversation_tool_images")
      .set({ status: "capturing", claimed_at: now })
      .where("id", "=", imageId)
      .where((eb) => eb.or([
        eb("status", "=", "pending"),
        eb.and([eb("status", "=", "capturing"), eb("claimed_at", "<", staleBefore)]),
      ]))
      .returning(["id", "workspace_id", "source_url"])
      .executeTakeFirst();
    if (claimed) {
      const image: ClaimedToolImage = { id: claimed.id, workspaceId: claimed.workspace_id, url: claimed.source_url ?? "", claimedAt: now };
      if (claimed.source_url) {
        return { kind: "claimed", image };
      }
      await this.markFailed({ image, reason: "source_missing" });
      return { kind: "failed" };
    }
    const row = await this.db.selectFrom("conversation_tool_images").select("status").where("id", "=", imageId).executeTakeFirst();
    if (!row) return { kind: "missing" };
    return row.status === "stored" ? { kind: "stored" } : row.status === "failed" ? { kind: "failed" } : { kind: "held" };
  }

  async markStored(input: { image: ClaimedToolImage; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("conversation_tool_images")
        .set({
          status: "stored",
          claimed_at: null,
          failure_reason: null,
          source_url: null,
          width: input.width,
          height: input.height,
          sha256: input.sha256,
          renditions: JSON.stringify(input.renditions),
          stored_at: new Date(),
        })
        .where("id", "=", input.image.id)
        .where("status", "=", "capturing")
        .where("claimed_at", "=", input.image.claimedAt)
        .returning("id")
        .executeTakeFirst();
      if (!row) {
        // Another capture took the row over: what this one wrote is its own, under its own names.
        await handOffToolImageObjects(this.jobsIn(trx), trx, asObjects(input.renditions));
      }
      return row !== undefined;
    });
  }

  async markFailed(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome }): Promise<void> {
    await this.db
      .updateTable("conversation_tool_images")
      .set({ status: "failed", failure_reason: input.reason, claimed_at: null, source_url: null })
      .where("id", "=", input.image.id)
      .where("status", "=", "capturing")
      .where("claimed_at", "=", input.image.claimedAt)
      .execute();
  }

  async release(input: { image: ClaimedToolImage; reason: ToolImageCaptureOutcome; leftovers: readonly ToolImageObject[] }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("conversation_tool_images")
        .set({ status: "pending", claimed_at: null, failure_reason: input.reason })
        .where("id", "=", input.image.id)
        .where("status", "=", "capturing")
        .where("claimed_at", "=", input.image.claimedAt)
        .execute();
      await handOffToolImageObjects(this.jobsIn(trx), trx, asObjects(input.leftovers));
    });
  }

  async findRendition(input: { imageId: string; width: number }): Promise<ToolImageRendition | null> {
    const row = await this.db
      .selectFrom("conversation_tool_images")
      .select("renditions")
      .where("id", "=", input.imageId)
      .where("status", "=", "stored")
      .executeTakeFirst();
    const renditions: unknown = row?.renditions;
    return (Array.isArray(renditions) ? renditions.map(renditionFrom) : [])
      .find((rendition): rendition is ToolImageRendition => rendition?.width === input.width) ?? null;
  }

  async failPending(input: { imageIds: readonly string[]; reason: "retries_exhausted" }): Promise<void> {
    if (input.imageIds.length === 0) return;
    await this.db
      .updateTable("conversation_tool_images")
      .set({ status: "failed", failure_reason: input.reason, claimed_at: null, source_url: null })
      .where((eb) => anyOf(eb.ref("id"), input.imageIds, "uuid[]"))
      .where("status", "in", ["pending", "capturing"])
      .execute();
  }
}
