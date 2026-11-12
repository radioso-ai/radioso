import { randomUUID } from "node:crypto";

import { AppError } from "../../../shared/domain/errors.js";
import type { UsageLimitPolicy, UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { VisitorImageClaim, VisitorImageTurnInput } from "../contracts/turnInput.js";
import {
  VISITOR_IMAGE_LIMITS,
  type VisitorImageAudit,
  type VisitorImageAvailability,
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
  new AppError(409, "visitor_image_unavailable", "An attached image cannot be sent: it is unknown or already sent, or the agent no longer takes images.");

interface VisitorImageServiceLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/**
 * The photo lifecycle, channel-neutral: every channel hands it bytes and an owner. An upload is
 * validated and re-encoded, stored under the workspace, and read once with the agent's chat
 * model, so the reading is ready when the message is sent. A send claims its photos for one
 * message, binds them to that message the moment the turn stores it, and lets them go when the
 * turn stored none. Photos are served to their owner, or to a teammate reading the conversation,
 * each view of which is audited.
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
    /** Whether the agent takes photos now, asked again at send: the operator may have turned them off since. */
    availability: VisitorImageAvailability;
    /** The plan: each reading is one answer, reserved before the photo is stored and read. */
    usage: Pick<UsageLimitPolicy, "reserveAnswer">;
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
    // Refused over plan with the error a chat turn gets, before anything is stored or read.
    const reservation = await this.deps.usage.reserveAnswer({ workspaceId: input.workspaceId, surface: input.surface, usage: "conversation_reply" });
    const id = this.newId();
    try {
      await this.store({ ...input, id, normalized });
    } catch (error) {
      await this.releaseReservation(reservation, input.workspaceId);
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
    // A photo the model could not read gave the visitor nothing, so it costs no answer.
    if (status === "read") await reservation.commit();
    else await this.releaseReservation(reservation, input.workspaceId);
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

  /**
   * The row first, naming where the bytes go, then the bytes: an object never exists without a
   * row, so a conversation's erasure and the unbound sweep always find it. A row whose bytes could
   * not be stored is deleted; one left behind is swept, and deleting bytes that never landed is
   * a deletion of nothing.
   */
  private async store(input: {
    id: string;
    workspaceId: string;
    agentId: string;
    owner: VisitorImageOwner;
    normalized: { jpeg: Buffer; width: number; height: number; sha256: string };
  }): Promise<void> {
    const { id, workspaceId, normalized } = input;
    await this.deps.store.insert({
      id,
      workspaceId,
      agentId: input.agentId,
      owner: input.owner,
      object: this.deps.objects.locate({ workspaceId, imageId: id }),
      byteSize: normalized.jpeg.length,
      width: normalized.width,
      height: normalized.height,
      sha256: normalized.sha256,
    });
    try {
      await this.deps.objects.put({ workspaceId, imageId: id, jpeg: normalized.jpeg });
    } catch (error) {
      await this.deps.store.delete({ workspaceId, id }).catch((deleteError: unknown) => {
        this.deps.logger.warn({ workspaceId, imageId: id, errorClass: errorClassOf(deleteError) }, "visitor_image_row_delete_failed");
      });
      throw error;
    }
  }

  private async releaseReservation(reservation: UsageLimitReservation, workspaceId: string): Promise<void> {
    await reservation.release().catch((error: unknown) => {
      this.deps.logger.warn({ workspaceId, errorClass: errorClassOf(error) }, "visitor_image_reservation_release_failed");
    });
  }

  async claim(input: Parameters<VisitorImageTurnInput["claim"]>[0]): Promise<VisitorImageClaim> {
    const unique = new Set(input.imageIds);
    if (input.imageIds.length === 0 || input.imageIds.length > VISITOR_IMAGE_LIMITS.maxImagesPerMessage || unique.size !== input.imageIds.length) {
      throw visitorImageUnavailable();
    }
    if (await this.deps.availability.forAgent({ workspaceId: input.workspaceId, agentId: input.agentId }) !== "available") {
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

  async bind(input: Parameters<VisitorImageTurnInput["bind"]>[0]): Promise<void> {
    const bound = await this.deps.store.bindClaim({
      workspaceId: input.workspaceId,
      claimId: input.claim.claimId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      boundAt: this.clock(),
    });
    if (bound < input.claim.images.length) {
      // Only a deletion between the claim and the message (the workspace's) leaves fewer to bind.
      this.deps.logger.warn({ workspaceId: input.workspaceId, conversationId: input.conversationId, claimId: input.claim.claimId, bound }, "visitor_image_bind_short");
    }
  }

  async release(input: Parameters<VisitorImageTurnInput["release"]>[0]): Promise<void> {
    const ids = { workspaceId: input.workspaceId, claimId: input.claim.claimId };
    try {
      const released = await this.deps.store.releaseClaim(ids);
      if (released > 0) this.deps.logger.info({ ...ids, released }, "visitor_image_claim_released");
    } catch (error) {
      this.deps.logger.warn({ ...ids, errorClass: errorClassOf(error) }, "visitor_image_release_failed");
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
