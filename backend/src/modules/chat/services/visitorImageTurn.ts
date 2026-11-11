import { badRequest } from "../../../shared/domain/errors.js";
import {
  renderVisitorImageTurn,
  type VisitorImageClaim,
  type VisitorImageTurnInput,
} from "../../visitorImages/public.js";
import type { AssistantChatRequest } from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";

/** A send's photos, claimed: the turn text it runs on, and the metadata its message stores. */
export interface VisitorImageTurn {
  readonly claim: VisitorImageClaim;
  readonly query: string;
  readonly inputMetadata: UserMessageInputMetadata;
}

/**
 * Claims a send's photos for its owner and renders them into the turn: the visitor's text, then
 * each photo's reading. Null for a send without photos. Refused (400) where the request names no
 * owner or agent, or nothing stores photos; a photo the owner cannot send is the port's 409.
 */
export const claimVisitorImageTurn = async (
  visitorImages: VisitorImageTurnInput | null,
  input: Pick<AssistantChatRequest, "workspaceId" | "agentId" | "message" | "inputMetadata" | "imageIds" | "imageOwner" | "routineInvocation">,
): Promise<VisitorImageTurn | null> => {
  if (!input.imageIds || input.imageIds.length === 0) return null;
  if (!visitorImages || !input.imageOwner || !input.agentId || input.routineInvocation) {
    throw badRequest("Images are not accepted on this request");
  }
  const claim = await visitorImages.claim({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    owner: input.imageOwner,
    imageIds: input.imageIds,
  });
  const typedText = input.message?.trim() ?? "";
  return {
    claim,
    query: renderVisitorImageTurn(typedText, claim.images),
    inputMetadata: {
      ...(input.inputMetadata ?? { method: "typed" }),
      imageInput: { typedText, images: claim.images.map((image) => ({ id: image.id, reading: image.reading })) },
    },
  };
};

const conversationIdOf = (event: object): string | null =>
  "conversationId" in event && typeof event.conversationId === "string" ? event.conversationId : null;

/**
 * Passes a streamed turn through, noting the conversation its events name, and settles the
 * photos once the stream ends, however it ends: bound to the message that carries them, or let go.
 */
export async function* settlingVisitorImages<TEvent extends object>(
  events: AsyncIterable<TEvent>,
  settle: (conversationId: string | null) => Promise<void>,
  knownConversationId: string | null,
): AsyncGenerator<TEvent> {
  let conversationId = knownConversationId;
  try {
    for await (const event of events) {
      conversationId ??= conversationIdOf(event);
      yield event;
    }
  } finally {
    await settle(conversationId);
  }
}
