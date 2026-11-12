import type { Kysely } from "kysely";

import type { BackgroundJobRequest, BackgroundJobWriter } from "../../../shared/background-jobs/index.js";
import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB, Db } from "../../../shared/infra/kysely/types.js";
import type { ToolImageRowWriter, ToolImageSource } from "../contracts/index.js";
import {
  TOOL_IMAGE_LIMITS,
  type ToolImageCaptureOutcome,
  type ToolImageClaim,
  type ToolImageObject,
  type ToolImageRendition,
  type ToolImageStore,
} from "../domain.js";
import { handOffToolImageObjects, toolImageCaptureRequests } from "../services/toolImageJobs.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** An object as a row's jsonb keeps it, or null when the value is not one. */
export const toolImageObjectFrom = (value: unknown): ToolImageObject | null => {
  if (!isRecord(value) || typeof value.bucket !== "string" || typeof value.objectPath !== "string") return null;
  return { bucket: value.bucket, objectPath: value.objectPath, generation: typeof value.generation === "string" ? value.generation : null };
};

const renditionFrom = (value: unknown): ToolImageRendition | null => {
  const object = toolImageObjectFrom(value);
  if (!object || !isRecord(value)) return null;
  const { width, height, sizeBytes } = value;
  return typeof width === "number" && typeof height === "number" && typeof sizeBytes === "number"
    ? { ...object, width, height, sizeBytes }
    : null;
};

/** Every stored object a row names: its source, when it still has one, and its renditions. */
export const toolImageObjectsOf = (row: { source_object: unknown; renditions: unknown }): ToolImageObject[] => [
  ...[toolImageObjectFrom(row.source_object)].filter((object): object is ToolImageObject => object !== null),
  ...(Array.isArray(row.renditions) ? row.renditions.map(renditionFrom) : [])
    .filter((rendition): rendition is ToolImageRendition => rendition !== null)
    .map(({ bucket, objectPath, generation }) => ({ bucket, objectPath, generation })),
];

/**
 * The `conversation_tool_images` rows. A row's objects are handed to the deletion job in the same
 * transaction that retires the row, so no object outlives its row unrecorded.
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
    const urls = input.sources.filter((source) => source.kind === "url");
    const inline = input.sources.filter((source) => source.kind === "inline").map((source) => source.imageId);
    if (urls.length > 0) {
      await transaction
        .insertInto("conversation_tool_images")
        .values(urls.map((source) => ({
          id: source.imageId,
          workspace_id: input.workspaceId,
          conversation_id: input.conversationId,
          message_id: input.messageId,
          source_kind: "url",
          source_url: source.url,
        })))
        .onConflict((conflict) => conflict.column("id").doNothing())
        .execute();
    }
    const bound = inline.length === 0 ? [] : await transaction
      .updateTable("conversation_tool_images")
      .set({ message_id: input.messageId })
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("message_id", "is", null)
      .where((eb) => anyOf(eb.ref("id"), inline, "uuid[]"))
      .returning("id")
      .execute();
    return toolImageCaptureRequests([...urls.map((source) => source.imageId), ...bound.map((row) => row.id)]);
  }

  /** A picture a skill returned as bytes, kept unbound until the reply that shows it binds it. */
  async insertInline(input: { id: string; workspaceId: string; conversationId: string; object: ToolImageObject }): Promise<void> {
    await this.db
      .insertInto("conversation_tool_images")
      .values({
        id: input.id,
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        source_kind: "inline",
        source_object: JSON.stringify(input.object),
      })
      .execute();
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
      .returning(["id", "workspace_id", "source_kind", "source_url", "source_object"])
      .executeTakeFirst();
    if (claimed) {
      const object = toolImageObjectFrom(claimed.source_object);
      if (claimed.source_kind === "url" && claimed.source_url) {
        return { kind: "claimed", image: { id: claimed.id, workspaceId: claimed.workspace_id, source: { kind: "url", url: claimed.source_url } } };
      }
      if (claimed.source_kind === "inline" && object) {
        return { kind: "claimed", image: { id: claimed.id, workspaceId: claimed.workspace_id, source: { kind: "inline", object } } };
      }
      await this.markFailed({ imageId, reason: "source_missing" });
      return { kind: "failed" };
    }
    const row = await this.db.selectFrom("conversation_tool_images").select("status").where("id", "=", imageId).executeTakeFirst();
    if (!row) return { kind: "missing" };
    return row.status === "stored" ? { kind: "stored" } : row.status === "failed" ? { kind: "failed" } : { kind: "held" };
  }

  async markStored(input: { imageId: string; width: number; height: number; sha256: string; renditions: readonly ToolImageRendition[] }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable("conversation_tool_images")
        .set({
          status: "stored",
          claimed_at: null,
          failure_reason: null,
          source_url: null,
          source_object: null,
          width: input.width,
          height: input.height,
          sha256: input.sha256,
          renditions: JSON.stringify(input.renditions),
          stored_at: new Date(),
        })
        .where("id", "=", input.imageId)
        .where("status", "=", "capturing")
        .returning("source_object")
        .executeTakeFirst();
      // Another capture took the row over and finished first: what this one wrote is not the row's.
      const leftover = row ? [toolImageObjectFrom(row.source_object)] : input.renditions;
      await handOffToolImageObjects(this.jobsIn(trx), trx, leftover.filter((object): object is ToolImageObject => object !== null));
    });
  }

  async markFailed(input: { imageId: string; reason: ToolImageCaptureOutcome; renditions?: readonly ToolImageRendition[] }): Promise<void> {
    await this.retire([input.imageId], input.reason, ["capturing"], input.renditions ?? []);
  }

  async failPending(input: { imageIds: readonly string[]; reason: "retries_exhausted" }): Promise<void> {
    await this.retire(input.imageIds, input.reason, ["pending", "capturing"], []);
  }

  async release(input: { imageId: string; reason: ToolImageCaptureOutcome }): Promise<void> {
    await this.db
      .updateTable("conversation_tool_images")
      .set({ status: "pending", claimed_at: null, failure_reason: input.reason })
      .where("id", "=", input.imageId)
      .where("status", "=", "capturing")
      .execute();
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

  /** Fails rows for good: the source is cleared, and its object and any partial copies go to the deletion job. */
  private async retire(
    imageIds: readonly string[],
    reason: string,
    from: ReadonlyArray<"pending" | "capturing">,
    written: readonly ToolImageObject[],
  ): Promise<void> {
    if (imageIds.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .updateTable("conversation_tool_images")
        .set({ status: "failed", failure_reason: reason, claimed_at: null, source_url: null, source_object: null })
        .where((eb) => anyOf(eb.ref("id"), imageIds, "uuid[]"))
        .where("status", "in", from)
        .returning("source_object")
        .execute();
      const objects = [...rows.map((row) => toolImageObjectFrom(row.source_object)), ...written];
      await handOffToolImageObjects(this.jobsIn(trx), trx, objects.filter((object): object is ToolImageObject => object !== null));
    });
  }
}
