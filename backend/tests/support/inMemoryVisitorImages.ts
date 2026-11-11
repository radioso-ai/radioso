import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type {
  ClaimedVisitorImageRow,
  NewVisitorImage,
  StoredVisitorImage,
  VisitorImageObject,
  VisitorImageObjectStore,
  VisitorImageOwner,
  VisitorImageStore,
} from "../../src/modules/visitorImages/domain.js";

interface Row extends StoredVisitorImage {
  claimId: string | null;
}

/**
 * The visitor image rows in memory, for unit and route tests. Binding asks `messageCarrying` for
 * the user message in a conversation whose metadata names the photo, which is what the Postgres
 * store reads from `messages`.
 */
export class InMemoryVisitorImageStore implements VisitorImageStore {
  readonly rows = new Map<string, Row>();

  constructor(
    private readonly messageCarrying: (input: { workspaceId: string; conversationId: string; imageId: string }) => Promise<string | null> | string | null = () => null,
  ) {}

  async insert(image: NewVisitorImage): Promise<void> {
    if (this.rows.has(image.id)) throw new Error("duplicate visitor image");
    this.rows.set(image.id, {
      id: image.id,
      workspaceId: image.workspaceId,
      agentId: image.agentId,
      owner: image.owner,
      conversationId: null,
      messageId: null,
      object: image.object,
      byteSize: image.byteSize,
      width: image.width,
      height: image.height,
      readingStatus: "pending",
      reading: null,
      createdAt: new Date(),
      claimId: null,
    });
  }

  async recordReading(input: Parameters<VisitorImageStore["recordReading"]>[0]): Promise<void> {
    const row = this.rows.get(input.id);
    if (!row || row.workspaceId !== input.workspaceId) return;
    this.rows.set(input.id, { ...row, readingStatus: input.status, reading: input.reading });
  }

  async claim(input: Parameters<VisitorImageStore["claim"]>[0]): Promise<ClaimedVisitorImageRow[] | null> {
    const rows = input.imageIds.map((id) => this.rows.get(id));
    const claimable = rows.every((row) => row
      && row.workspaceId === input.workspaceId
      && row.agentId === input.agentId
      && sameOwner(row.owner, input.owner)
      && row.messageId === null
      && row.claimId === null);
    if (!claimable || new Set(input.imageIds).size !== input.imageIds.length) return null;
    return rows.map((row) => {
      const claimed = { ...row!, claimId: input.claimId };
      this.rows.set(claimed.id, claimed);
      return { id: claimed.id, readingStatus: claimed.readingStatus, reading: claimed.reading };
    });
  }

  async bindClaim(input: Parameters<VisitorImageStore["bindClaim"]>[0]): Promise<number> {
    let bound = 0;
    for (const row of this.rows.values()) {
      if (row.workspaceId !== input.workspaceId || row.claimId !== input.claimId || row.messageId !== null) continue;
      const messageId = await this.messageCarrying({ workspaceId: input.workspaceId, conversationId: input.conversationId, imageId: row.id });
      if (!messageId) continue;
      this.rows.set(row.id, { ...row, conversationId: input.conversationId, messageId });
      bound += 1;
    }
    return bound;
  }

  async releaseClaim(input: Parameters<VisitorImageStore["releaseClaim"]>[0]): Promise<number> {
    let released = 0;
    for (const row of this.rows.values()) {
      if (row.workspaceId !== input.workspaceId || row.claimId !== input.claimId || row.messageId !== null) continue;
      this.rows.set(row.id, { ...row, claimId: null });
      released += 1;
    }
    return released;
  }

  async findForOwner(input: { workspaceId: string; owner: VisitorImageOwner; id: string }): Promise<StoredVisitorImage | null> {
    const row = this.rows.get(input.id);
    return row && row.workspaceId === input.workspaceId && sameOwner(row.owner, input.owner) ? row : null;
  }

  async findInConversation(input: { workspaceId: string; conversationId: string; id: string }): Promise<StoredVisitorImage | null> {
    const row = this.rows.get(input.id);
    return row && row.workspaceId === input.workspaceId && row.conversationId === input.conversationId ? row : null;
  }

  async delete(input: { workspaceId: string; id: string }): Promise<void> {
    const row = this.rows.get(input.id);
    if (row?.workspaceId === input.workspaceId) this.rows.delete(input.id);
  }
}

const sameOwner = (left: VisitorImageOwner, right: VisitorImageOwner): boolean => left.kind === right.kind && left.id === right.id;

/** The user message in a conversation whose stored photos name `imageId`, as the Postgres bind finds it. */
export const messageCarryingImage = (messages: { listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> }) =>
  async (input: { workspaceId: string; conversationId: string; imageId: string }): Promise<string | null> => {
    const carrying = (await messages.listByConversationId(input.workspaceId, input.conversationId))
      .find((message) => message.role === "user" && message.inputMetadata?.imageInput?.images.some((image) => image.id === input.imageId));
    return carrying?.id ?? null;
  };

/** The bytes in memory, under the same path the storage adapters give them. */
export class InMemoryVisitorImageObjects implements VisitorImageObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(input: { workspaceId: string; imageId: string; jpeg: Buffer }): Promise<VisitorImageObject> {
    const objectPath = `workspaces/${input.workspaceId}/visitor-images/${input.imageId}`;
    this.objects.set(objectPath, input.jpeg);
    return { bucket: "memory", objectPath, generation: null };
  }

  async get(object: VisitorImageObject): Promise<Buffer> {
    const bytes = this.objects.get(object.objectPath);
    if (!bytes) throw new Error("visitor image object not found");
    return bytes;
  }

  async remove(object: VisitorImageObject): Promise<void> {
    this.objects.delete(object.objectPath);
  }
}
