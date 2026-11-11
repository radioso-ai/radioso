import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/domain/errors.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { VisitorImageClaim, VisitorImageTurnInput } from "../contracts/turnInput.js";
import {
  VISITOR_IMAGE_LIMITS,
  type VisitorImageAudit,
  type VisitorImageObjectStore,
  type VisitorImageOwner,
  type VisitorImageReader,
  type VisitorImageRejection,
  type VisitorImageStore,
} from "../domain.js";
import { normalizeVisitorImage } from "./imageNormalizer.js";
import {
  recordVisitorImageReading,
  recordVisitorImageUpload,
  uploadOutcomeForRejection,
  type VisitorImageMetricsSink,
} from "./visitorImageMetrics.js";

export type VisitorImageUploadResult =
  | { readonly kind: "accepted"; readonly id: string; readonly readingStatus: "read" | "unread" }
  | { readonly kind: "rejected"; readonly reason: VisitorImageRejection };

const visitorImageUnavailable = (): AppError =>
  new AppError(409, "visitor_image_unavailable", "An attached image is unknown or was already sent. Upload it again.");

interface VisitorImageServiceLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The photo lifecycle, channel-neutral: every channel hands it bytes and an owner. An upload is
 * validated and re-encoded, stored under the workspace, and read once with the agent's chat
 * model, so the reading is ready when the message is sent. A send claims its photos for one
 * message and, once the turn is over, binds them to the message that carries them. Photos are
 * served to their owner, or to a teammate reading the conversation, each view of which is audited.
 * It knows nothing about chat turns: the door renders the readings into the turn.
 */
export class VisitorImageService implements VisitorImageTurnInput {
  private readonly newId: () => string;
  private readonly clock: () => Date;

  constructor(private readonly deps: {
    store: VisitorImageStore;
    objects: VisitorImageObjectStore;
    reader: VisitorImageReader;
    audit: VisitorImageAudit;
    metrics?: VisitorImageMetricsSink | null;
    /** Ids, outcomes and error classes only; never bytes or readings. */
    logger: VisitorImageServiceLogger;
    newId?: () => string;
    clock?: () => Date;
  }) {
    this.newId = deps.newId ?? randomUUID;
    this.clock = deps.clock ?? (() => new Date());
  }

  async upload(input: {
    workspaceId: string;
    agentId: string;
    owner: VisitorImageOwner;
    bytes: Buffer;
    /** The language the reading is written in; null falls back to the agent's default locale. */
    locale: string | null;
    /** The channel the photo came through, for usage attribution. */
    surface: string;
  }): Promise<VisitorImageUploadResult> {
    const normalized = await normalizeVisitorImage(input.bytes);
    if (normalized.kind === "rejected") {
      recordVisitorImageUpload(this.deps.metrics, uploadOutcomeForRejection(normalized.reason));
      this.deps.logger.info({ workspaceId: input.workspaceId, agentId: input.agentId, reason: normalized.reason }, "visitor_image_rejected");
      return normalized;
    }
    const id = this.newId();
    const object = await this.deps.objects.put({ workspaceId: input.workspaceId, imageId: id, jpeg: normalized.jpeg });
    try {
      await this.deps.store.insert({
        id,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        owner: input.owner,
        object,
        byteSize: normalized.jpeg.length,
        width: normalized.width,
        height: normalized.height,
        sha256: normalized.sha256,
      });
    } catch (error) {
      await this.deps.objects.remove(object).catch(() => undefined);
      throw error;
    }
    recordVisitorImageUpload(this.deps.metrics, "accepted");

    const reading = await this.deps.reader.read({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      imageId: id,
      image: { mediaType: "image/jpeg", base64Data: normalized.jpeg.toString("base64") },
      locale: input.locale,
      surface: input.surface,
    });
    const status = reading.kind === "read" ? "read" : "unread";
    await this.deps.store.recordReading({
      workspaceId: input.workspaceId,
      id,
      status,
      reading: reading.kind === "read" ? reading.description.slice(0, VISITOR_IMAGE_LIMITS.maxReadingChars) : null,
      readAt: this.clock(),
    });
    recordVisitorImageReading(this.deps.metrics, status);
    this.deps.logger.info({ workspaceId: input.workspaceId, agentId: input.agentId, imageId: id, readingStatus: status }, "visitor_image_uploaded");
    return { kind: "accepted", id, readingStatus: status };
  }

  async claim(input: Parameters<VisitorImageTurnInput["claim"]>[0]): Promise<VisitorImageClaim> {
    const unique = new Set(input.imageIds);
    if (input.imageIds.length === 0 || input.imageIds.length > VISITOR_IMAGE_LIMITS.maxImagesPerMessage || unique.size !== input.imageIds.length) {
      throw visitorImageUnavailable();
    }
    const claimId = this.newId();
    const claimed = await this.deps.store.claim({ ...input, claimId, claimedAt: this.clock() });
    if (!claimed) throw visitorImageUnavailable();
    const byId = new Map(claimed.map((row) => [row.id, row]));
    return {
      claimId,
      images: input.imageIds.map((id) => {
        const row = byId.get(id);
        return { id, reading: row?.readingStatus === "read" ? row.reading : null };
      }),
    };
  }

  async settle(input: Parameters<VisitorImageTurnInput["settle"]>[0]): Promise<void> {
    const ids = { workspaceId: input.workspaceId, conversationId: input.conversationId, claimId: input.claim.claimId };
    try {
      const bound = input.conversationId
        ? await this.deps.store.bindClaim({ workspaceId: input.workspaceId, claimId: input.claim.claimId, conversationId: input.conversationId, boundAt: this.clock() })
        : 0;
      const released = bound < input.claim.images.length
        ? await this.deps.store.releaseClaim({ workspaceId: input.workspaceId, claimId: input.claim.claimId })
        : 0;
      if (released > 0) this.deps.logger.info({ ...ids, bound, released }, "visitor_image_claim_released");
    } catch (error) {
      this.deps.logger.warn({ ...ids, errorClass: errorClassOf(error) }, "visitor_image_settle_failed");
    }
  }

  /** The photo's bytes for the owner who uploaded it, bound or not; null for anyone else. */
  async readForOwner(input: { workspaceId: string; owner: VisitorImageOwner; imageId: string }): Promise<Buffer | null> {
    const image = await this.deps.store.findForOwner({ workspaceId: input.workspaceId, owner: input.owner, id: input.imageId });
    return image ? this.deps.objects.get(image.object) : null;
  }

  /** A conversation's photo for a teammate reading it; every view that sends bytes is audited. */
  async readInConversation(input: {
    workspaceId: string;
    conversationId: string;
    imageId: string;
    actorUserId: string | null;
  }): Promise<Buffer | null> {
    const image = await this.deps.store.findInConversation({ workspaceId: input.workspaceId, conversationId: input.conversationId, id: input.imageId });
    if (!image) return null;
    const bytes = await this.deps.objects.get(image.object);
    await this.deps.audit.viewed({ workspaceId: input.workspaceId, conversationId: input.conversationId, imageId: input.imageId, actorUserId: input.actorUserId });
    return bytes;
  }
}
