import { badRequest } from "../../../shared/domain/errors.js";
import { renderVisitorImageTurn, type VisitorImageTurnInput } from "../../visitorImages/public.js";
import type { AssistantChatRequest, UserMessageStoredListener } from "../types/assistantApi.js";
import type { UserMessageInputMetadata } from "../../../db/repositories/messageRepository.js";

/**
 * A send's photos, claimed: the turn text it runs on, the metadata its message stores, the
 * listener that binds the photos to that message the moment the turn stores it, and `finish`,
 * which lets them go once the turn is over if no message took them.
 */
interface VisitorImageTurn {
  readonly query: string;
  readonly inputMetadata: UserMessageInputMetadata;
  readonly onUserMessageStored: UserMessageStoredListener;
  finish(): Promise<void>;
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
  const { workspaceId } = input;
  const claim = await visitorImages.claim({ workspaceId, agentId: input.agentId, owner: input.imageOwner, imageIds: input.imageIds });
  const typedText = input.message?.trim() ?? "";
  let bound = false;
  return {
    query: renderVisitorImageTurn(typedText, claim.images),
    inputMetadata: {
      ...(input.inputMetadata ?? { method: "typed" }),
      imageInput: { typedText, images: claim.images.map((image) => ({ id: image.id, reading: image.reading })) },
    },
    onUserMessageStored: async ({ conversationId, messageId }) => {
      await visitorImages.bind({ workspaceId, claim, conversationId, messageId });
      bound = true;
    },
    finish: async () => {
      if (!bound) await visitorImages.release({ workspaceId, claim });
    },
  };
};
