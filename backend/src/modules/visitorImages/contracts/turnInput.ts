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

/** The photos one send claimed, in the order the caller named them. */
export interface VisitorImageClaim {
  readonly claimId: string;
  readonly images: readonly { readonly id: string; readonly reading: string | null }[];
}

/**
 * What the chat door needs from the photos of one send: claim them for this owner, bind them to
 * the user message the turn stores the moment it exists, or let them go when the turn stored none.
 * It knows neither storage nor the reading call, nor how a message keeps its photos.
 */
export interface VisitorImageTurnInput {
  /**
   * Claims the photos for one message. Throws `visitor_image_unavailable` (409) when the agent no
   * longer takes photos, or any id is not this workspace's, agent's and owner's, or another send
   * already holds it.
   */
  claim(input: {
    workspaceId: string;
    agentId: string;
    owner: VisitorImageOwner;
    imageIds: readonly string[];
  }): Promise<VisitorImageClaim>;
  /** Binds the claimed photos to the user message that carries them. A failure is the turn's failure. */
  bind(input: { workspaceId: string; claim: VisitorImageClaim; conversationId: string; messageId: string }): Promise<void>;
  /**
   * Lets go of claimed photos no message took, so the caller can send them again; a bound photo
   * stays bound. Never throws: a photo it cannot let go of is deleted with the unsent ones.
   */
  release(input: { workspaceId: string; claim: VisitorImageClaim }): Promise<void>;
}
