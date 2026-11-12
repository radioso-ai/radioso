import type { LlmCapabilityOverride } from "../../shared/infra/llm/workspaceContext.js";
import type { VisitorImageOwner } from "./contracts/turnInput.js";

export type { VisitorImageOwner, VisitorImageOwnerKind } from "./contracts/turnInput.js";

/** The bounds every channel's photos are held to; the server is the authority for all of them. */
export const VISITOR_IMAGE_LIMITS = {
  /** The raw upload, before re-encoding. */
  maxUploadBytes: 10 * 1024 * 1024,
  /** The stored JPEG: quality steps down until it fits. */
  maxStoredBytes: 512 * 1024,
  /** The stored JPEG's long side. */
  maxLongSidePx: 1_600,
  /** Decoding stops past this many pixels (about 8,660 by 5,770), so a crafted file cannot exhaust memory. */
  maxInputPixels: 50_000_000,
  /** Photos one message carries. */
  maxImagesPerMessage: 3,
  /** A photo no message carries is deleted this long after its upload. */
  unboundLifetimeMs: 24 * 60 * 60 * 1_000,
  /** The reading kept and rendered into the turn. */
  maxReadingChars: 2_000,
} as const;

/** The types a photo may be, read from its magic bytes; whatever a caller declared is ignored. */
export type VisitorImageSourceType = "image/jpeg" | "image/png" | "image/webp";

/**
 * Why an upload was refused. Each is a bounded metric label and an error code at the edge; `busy`
 * is the process decoding as many photos as it takes at once, not the photo.
 */
export type VisitorImageRejection = "unsupported_type" | "too_large" | "too_many_pixels" | "busy";

/** Whether the agent's chat model produced a reading. `pending` only while the reading call runs. */
export type VisitorImageReadingStatus = "pending" | "read" | "unread";

/** Where one stored photo's bytes live in document storage. */
export interface VisitorImageObject {
  readonly bucket: string;
  readonly objectPath: string;
  readonly generation: string | null;
}

/** One stored photo, as the module reads it back. */
export interface StoredVisitorImage {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string | null;
  readonly owner: VisitorImageOwner;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly object: VisitorImageObject;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly readingStatus: VisitorImageReadingStatus;
  readonly reading: string | null;
  readonly createdAt: Date;
}

/** A photo as its upload records it, before anything reads it. */
export interface NewVisitorImage {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly owner: VisitorImageOwner;
  readonly object: VisitorImageObject;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

/** A claimed photo: its id and what the turn renders for it, in the order the caller named them. */
export interface ClaimedVisitorImageRow {
  readonly id: string;
  readonly readingStatus: VisitorImageReadingStatus;
  readonly reading: string | null;
}

/** The module's rows. The Postgres implementation is `infra/visitorImageRepository.ts`. */
export interface VisitorImageStore {
  insert(image: NewVisitorImage): Promise<void>;
  recordReading(input: {
    workspaceId: string;
    id: string;
    status: Exclude<VisitorImageReadingStatus, "pending">;
    reading: string | null;
    readAt: Date;
  }): Promise<void>;
  /**
   * Claims every id for one send, atomically: each must be the workspace's, the agent's and the
   * owner's, carried by no message and claimed by no other send. Returns null, claiming none,
   * when any of them is not.
   */
  claim(input: {
    workspaceId: string;
    agentId: string;
    owner: VisitorImageOwner;
    imageIds: readonly string[];
    claimId: string;
    claimedAt: Date;
  }): Promise<ClaimedVisitorImageRow[] | null>;
  /** Binds the claim's unbound photos to one message of one conversation. Returns how many it bound. */
  bindClaim(input: { workspaceId: string; claimId: string; conversationId: string; messageId: string; boundAt: Date }): Promise<number>;
  /** Lets the claim's photos that no message carries be claimed again. Returns how many it let go. */
  releaseClaim(input: { workspaceId: string; claimId: string }): Promise<number>;
  findForOwner(input: { workspaceId: string; owner: VisitorImageOwner; id: string }): Promise<StoredVisitorImage | null>;
  findInConversation(input: { workspaceId: string; conversationId: string; id: string }): Promise<StoredVisitorImage | null>;
  /** Removes the row of an upload whose bytes could not be stored. */
  delete(input: { workspaceId: string; id: string }): Promise<void>;
}

/** Where the bytes go: document storage, narrowed to one folder of the workspace. */
export interface VisitorImageObjectStore {
  /** Where a photo's bytes go, known before they are written, so its row names them first. */
  locate(input: { workspaceId: string; imageId: string }): VisitorImageObject;
  /** Writes the photo's bytes where `locate` says. */
  put(input: { workspaceId: string; imageId: string; jpeg: Buffer }): Promise<void>;
  get(object: VisitorImageObject): Promise<Buffer>;
  /** Deletes a photo's bytes; bytes that are gone, or never landed, count as deleted. */
  remove(object: VisitorImageObject): Promise<void>;
}

/** The JPEG a reader is handed, as raw base64 with no `data:` prefix. Never logged. */
export interface VisitorImageForReading {
  readonly mediaType: "image/jpeg";
  readonly base64Data: string;
}

/** What one reading call produced. A failure is never an error to the upload: the photo is unread. */
export type VisitorImageReading =
  | { readonly kind: "read"; readonly description: string }
  | { readonly kind: "unread"; readonly reason: VisitorImageUnreadReason };

export type VisitorImageUnreadReason = "agent_not_found" | "model_cannot_read" | "timeout" | "invalid_result" | "failed";

/** Reads a photo with the agent's chat model. Composition binds the model; see `services/modelVisitorImageReader.ts`. */
export interface VisitorImageReader {
  read(input: {
    workspaceId: string;
    agentId: string;
    imageId: string;
    image: VisitorImageForReading;
    /** The language the reading is written in; null falls back to the agent's default locale. */
    locale: string | null;
    /** The channel the photo came through, for usage attribution. */
    surface: string;
  }): Promise<VisitorImageReading>;
}

/** The record each operator view of a photo leaves: ids only. */
export interface VisitorImageAudit {
  viewed(input: { workspaceId: string; conversationId: string; imageId: string; actorUserId: string | null }): Promise<void>;
}

/**
 * Whether an agent takes photos now: its operator turned them on, and its chat model, resolved as
 * its turns resolve it, reads images. Uploads are refused otherwise, and a client shows no attach
 * control. Composition implements it.
 */
export type VisitorImageAgentAvailability = "available" | "disabled" | "model_cannot_read" | "agent_not_found";

export interface VisitorImageAvailability {
  forAgent(input: { workspaceId: string; agentId: string }): Promise<VisitorImageAgentAvailability>;
}

/**
 * Whether the model an agent answers with reads images, decided as its turns decide it (its own
 * override, the workspace's chat model, the plan, the deployment's default), without
 * touching keys. Photos are available where this holds and the operator has them on; a settings
 * read reports it alone. A selection that cannot be decided reads as a model that cannot read.
 * Composition implements it.
 */
export interface ChatModelImageReading {
  readsImages(agent: { id?: string; workspaceId: string; chatModelOverride: LlmCapabilityOverride | null }): Promise<boolean>;
}
