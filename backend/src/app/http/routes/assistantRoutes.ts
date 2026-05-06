import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { assistantChatSchema } from "../schemas/assistantChatSchemas.js";

type AssistantRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "assistantChatService">;

export const createAssistantRoutes = (dependencies: AssistantRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);

  router.post("/chat", workspaceSession, validateBody(assistantChatSchema), async (req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      if (req.body.stream && req.body.startConversation) {
        throw badRequest("startConversation does not support streaming");
      }
      if (req.body.stream) {
        await sendChatSse(
          res,
          dependencies.assistantChatService.streamAnswer({
            workspaceId,
            accountId,
            conversationId: req.body.conversationId,
            message: req.body.message,
            startConversation: req.body.startConversation,
            stream: req.body.stream,
            userExpectedLocale: req.body.userExpectedLocale,
            inputMetadata: req.body.inputMetadata,
            sourceContext: req.body.sourceContext,
            metadataFilter: req.body.metadataFilter,
            sourceChannel: req.body.sourceContext?.surface ?? null,
            sourceOrigin: req.body.sourceContext?.sourceOrigin ?? null,
          }),
        );
        return;
      }

      const response = await dependencies.assistantChatService.answer({
        workspaceId,
        accountId,
        conversationId: req.body.conversationId,
        message: req.body.message,
        startConversation: req.body.startConversation,
        stream: req.body.stream,
        userExpectedLocale: req.body.userExpectedLocale,
        inputMetadata: req.body.inputMetadata,
        sourceContext: req.body.sourceContext,
        metadataFilter: req.body.metadataFilter,
        sourceChannel: req.body.sourceContext?.surface ?? null,
        sourceOrigin: req.body.sourceContext?.sourceOrigin ?? null,
      });
      if (!response) {
        res.status(204).end();
        return;
      }
      sendChatJson(res, response);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
