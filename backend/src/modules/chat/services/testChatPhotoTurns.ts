import type { TestExecutionPhotoTurnsPort } from "../../test-execution/public.js";
import type { VisitorImageTurnInput } from "../../visitorImages/public.js";
import { claimVisitorImageTurn } from "./visitorImageTurn.js";

/**
 * Test Chat's photos through the chat door's own claim: the same claim for whoever uploaded them,
 * the same turn text and stored form. The test's store binds the claim to the test in the
 * transaction that stores the turn (a test keeps its transcript apart from conversations);
 * `release` lets the photos go when no turn took them.
 */
export const createTestChatPhotoTurns = (visitorImages: VisitorImageTurnInput): TestExecutionPhotoTurnsPort => ({
  claim: async ({ workspaceId, agentId, message, imageIds, owner, revision }) => {
    const turn = await claimVisitorImageTurn(visitorImages, { workspaceId, agentId, message, imageIds, imageOwner: owner, imageRevision: revision });
    // `claimVisitorImageTurn` answers null only for a send without photos, which never comes here.
    if (!turn) throw new Error("test_chat_photo_turn_without_photos");
    return {
      message: turn.query,
      imageInput: turn.inputMetadata.imageInput,
      claim: turn.claim,
      release: () => turn.finish(),
    };
  },
});
