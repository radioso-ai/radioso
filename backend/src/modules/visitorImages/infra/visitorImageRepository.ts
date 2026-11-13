import type { Kysely, Selectable } from "kysely";

import type { VisitorImageClaim, VisitorImageHolder } from "../contracts/turnInput.js";

import { anyOf } from "../../../shared/infra/kysely/sqlHelpers.js";
import type { DB } from "../../../shared/infra/kysely/types.js";
import type {
  ClaimedVisitorImageRow,
  NewVisitorImage,
  StoredVisitorImage,
  VisitorImageOwner,
  VisitorImageOwnerKind,
  VisitorImageReadingStatus,
  VisitorImageStore,
} from "../domain.js";

type VisitorImageRow = Selectable<DB["visitor_images"]>;

const OWNER_KINDS: ReadonlySet<string> = new Set<VisitorImageOwnerKind>(["public_session", "api_credential", "user", "connector_conversation"]);
const READING_STATUSES: ReadonlySet<string> = new Set<VisitorImageReadingStatus>(["pending", "read", "unread"]);

const mapRow = (row: VisitorImageRow): StoredVisitorImage => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id,
  owner: {
    // The column's CHECK holds the same set; an unknown kind would match no owner anyway.
    kind: (OWNER_KINDS.has(row.owner_kind) ? row.owner_kind : "user") as VisitorImageOwnerKind,
    id: row.owner_id,
  },
  conversationId: row.conversation_id,
  messageId: row.message_id,
  testExecutionId: row.test_execution_id,
  object: { bucket: row.storage_bucket, objectPath: row.storage_object_path, generation: row.storage_generation },
  byteSize: row.byte_size,
  width: row.width,
  height: row.height,
  readingStatus: (READING_STATUSES.has(row.reading_status) ? row.reading_status : "pending") as VisitorImageReadingStatus,
  reading: row.reading,
  createdAt: new Date(row.created_at),
});

/** Thrown inside a claim's transaction to roll it back when any id was not claimable. */
class UnclaimableVisitorImages extends Error {
  override readonly name = "UnclaimableVisitorImages";
}

/** `visitor_images` over Kysely. */
export class PostgresVisitorImageStore implements VisitorImageStore {
  constructor(private readonly db: Kysely<DB>) {}

  async insert(image: NewVisitorImage): Promise<void> {
    await this.db
      .insertInto("visitor_images")
      .values({
        id: image.id,
        workspace_id: image.workspaceId,
        agent_id: image.agentId,
        owner_kind: image.owner.kind,
        owner_id: image.owner.id,
        storage_bucket: image.object.bucket,
        storage_object_path: image.object.objectPath,
        storage_generation: image.object.generation,
        byte_size: image.byteSize,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
      })
      .execute();
  }

  async recordReading(input: Parameters<VisitorImageStore["recordReading"]>[0]): Promise<void> {
    await this.db
      .updateTable("visitor_images")
      .set({ reading_status: input.status, reading: input.reading, read_at: input.readAt })
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.id)
      .execute();
  }

  async claim(input: Parameters<VisitorImageStore["claim"]>[0]): Promise<ClaimedVisitorImageRow[] | null> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const rows = await trx
          .updateTable("visitor_images")
          .set({ claim_id: input.claimId, claimed_at: input.claimedAt })
          .where("workspace_id", "=", input.workspaceId)
          .where("agent_id", "=", input.agentId)
          .where("owner_kind", "=", input.owner.kind)
          .where("owner_id", "=", input.owner.id)
          .where("message_id", "is", null)
          .where("claim_id", "is", null)
          .where((eb) => anyOf(eb.ref("id"), input.imageIds, "uuid[]"))
          .returning(["id", "reading_status", "reading"])
          .execute();
        if (rows.length !== new Set(input.imageIds).size || rows.length !== input.imageIds.length) {
          throw new UnclaimableVisitorImages();
        }
        return rows.map((row) => ({
          id: row.id,
          readingStatus: (READING_STATUSES.has(row.reading_status) ? row.reading_status : "pending") as VisitorImageReadingStatus,
          reading: row.reading,
        }));
      });
    } catch (error) {
      if (error instanceof UnclaimableVisitorImages) return null;
      throw error;
    }
  }

  /**
   * The caller names what carries the photos: the message the turn stored, or the Test Chat test
   * whose turn it stored, in the same request, before the turn ran on.
   */
  async bindClaim(input: Parameters<VisitorImageStore["bindClaim"]>[0]): Promise<number> {
    const holder = "testExecutionId" in input
      ? { test_execution_id: input.testExecutionId }
      : { conversation_id: input.conversationId, message_id: input.messageId };
    const result = await this.db
      .updateTable("visitor_images")
      .set({ ...holder, bound_at: input.boundAt })
      .where("workspace_id", "=", input.workspaceId)
      .where("claim_id", "=", input.claimId)
      .where("message_id", "is", null)
      .where("test_execution_id", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async releaseClaim(input: Parameters<VisitorImageStore["releaseClaim"]>[0]): Promise<number> {
    const result = await this.db
      .updateTable("visitor_images")
      .set({ claim_id: null, claimed_at: null })
      .where("workspace_id", "=", input.workspaceId)
      .where("claim_id", "=", input.claimId)
      .where("message_id", "is", null)
      .where("test_execution_id", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async findForOwner(input: { workspaceId: string; owner: VisitorImageOwner; id: string }): Promise<StoredVisitorImage | null> {
    const row = await this.db
      .selectFrom("visitor_images")
      .selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.id)
      .where("owner_kind", "=", input.owner.kind)
      .where("owner_id", "=", input.owner.id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findCarried(input: { workspaceId: string; agentId: string; id: string }): Promise<StoredVisitorImage | null> {
    const row = await this.db
      .selectFrom("visitor_images")
      .selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("agent_id", "=", input.agentId)
      .where("id", "=", input.id)
      .where((eb) => eb.or([eb("message_id", "is not", null), eb("test_execution_id", "is not", null)]))
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findInTest(input: { workspaceId: string; agentId: string; testExecutionId: string; id: string }): Promise<StoredVisitorImage | null> {
    const row = await this.db
      .selectFrom("visitor_images")
      .selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("agent_id", "=", input.agentId)
      .where("test_execution_id", "=", input.testExecutionId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findInConversation(input: { workspaceId: string; conversationId: string; id: string }): Promise<StoredVisitorImage | null> {
    const row = await this.db
      .selectFrom("visitor_images")
      .selectAll()
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("id", "=", input.id)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async delete(input: { workspaceId: string; id: string }): Promise<void> {
    await this.db.deleteFrom("visitor_images").where("workspace_id", "=", input.workspaceId).where("id", "=", input.id).execute();
  }
}

/**
 * Binds a claim's photos to what holds them through the caller's transaction, so the photos and the
 * record that names them are written together. Throws when it bound fewer than were claimed, which
 * rolls the record back rather than let it name photos nothing holds.
 */
export const bindVisitorImageClaimIn = (db: Kysely<DB>) =>
  async (input: { workspaceId: string; claim: VisitorImageClaim; boundAt: Date } & VisitorImageHolder): Promise<void> => {
    const { claim, ...binding } = input;
    const bound = await new PostgresVisitorImageStore(db).bindClaim({ ...binding, claimId: claim.claimId });
    if (bound !== claim.images.length) throw new Error("visitor_image_bind_short");
  };
