import type { TestExecutionPhotoTurnsPort } from "../../test-execution/public.js";
import type { VisitorImageTurnInput } from "../../visitorImages/public.js";
import { claimVisitorImageTurn } from "./visitorImageTurn.js";

/**
 * Test Chat's photos through the chat door's own claim: the same claim for whoever uploaded them,
 * the same turn text and stored form, bound to the test once its turn is stored (a test keeps its
 * transcript apart from conversations), and let go when it was not.
 */
export const createTestChatPhotoTurns = (visitorImages: VisitorImageTurnInput): TestExecutionPhotoTurnsPort => ({
  claim: async ({ workspaceId, agentId, executionId, message, imageIds, owner }) => {
    const turn = await claimVisitorImageTurn(visitorImages, { workspaceId, agentId, message, imageIds, imageOwner: owner });
    // `claimVisitorImageTurn` answers null only for a send without photos, which never comes here.
    if (!turn) throw new Error("test_chat_photo_turn_without_photos");
    return {
      message: turn.query,
      imageInput: turn.inputMetadata.imageInput,
      stored: () => turn.bind({ testExecutionId: executionId }),
      finish: () => turn.finish(),
    };
  },
});
