import { z } from "zod";

/**
 * Who may send a photo in a turn, recorded at upload and checked at send. Every channel hands the
 * module bytes plus one of these: the website embed and the public link their public chat session,
 * the REST API its credential (or the signed-in user, for the dashboard), and a connector its own
 * conversation. The id is never a credential.
 */
export type VisitorImageOwnerKind = "public_session" | "api_credential" | "user" | "connector_conversation";

export interface VisitorImageOwner {
  readonly kind: VisitorImageOwnerKind;
  readonly id: string;
}

/**
 * The key a user message's metadata keeps its photos under. The module writes the shape and reads
 * it back when it binds a send's photos to the message that carries them.
 */
export const VISITOR_IMAGE_INPUT_METADATA_KEY = "imageInput";

/**
 * A message's photos as stored: what the visitor typed, apart from the readings the turn text
 * carries, and each photo's id with its reading (null when it could not be read). The UIs render
 * the typed text and thumbnails from it, so a reading never shows in the visitor's own bubble.
 */
export const visitorImageInputSchema = z.object({
  typedText: z.string(),
  images: z.array(z.object({
    id: z.string().uuid(),
    reading: z.string().nullable(),
  })).min(1).max(3),
});

export type VisitorImageInput = z.infer<typeof visitorImageInputSchema>;

/** The photos one send claimed, in the order the caller named them. */
export interface VisitorImageClaim {
  readonly claimId: string;
  readonly images: readonly { readonly id: string; readonly reading: string | null }[];
}

/**
 * What the chat door needs from the photos of one send: claim them for this owner, then bind them
 * to the message that carries them. It knows neither storage nor the reading call.
 */
export interface VisitorImageTurnInput {
  /**
   * Claims the photos for one message. Throws `visitor_image_unavailable` (409) when any id is not
   * this workspace's, agent's and owner's, or another message already carries it.
   */
  claim(input: {
    workspaceId: string;
    agentId: string;
    owner: VisitorImageOwner;
    imageIds: readonly string[];
  }): Promise<VisitorImageClaim>;
  /**
   * Once the turn is over: binds the claimed photos to the user message in `conversationId` that
   * carries them, and lets go of any no message carries, so the caller can send them again. Never
   * throws; a photo left unbound is deleted with the unbound ones.
   */
  settle(input: { workspaceId: string; claim: VisitorImageClaim; conversationId: string | null }): Promise<void>;
}
