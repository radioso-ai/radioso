import type { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { validateBody } from "../middleware/validate.js";
import {
  requireRestAgentChannelCredential,
  type AgentChannelCredentialLocals,
} from "../middleware/requireAgentChannelCredential.js";
import {
  agentChannelChatRateLimiters,
  createAgentChannelSourceRateLimiter,
  type AgentChannelRateLimiterDependencies,
} from "../middleware/agentChannelRateLimiter.js";
import { onSuccessfulHttpResponse } from "../middleware/httpResponseCompletion.js";
import { sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { recordEdgeFactsProofRejected, resolveConversationRequestContext } from "../shared/conversationRequestContext.js";
import { agentChannelChatSchema } from "../schemas/agentChannelSchemas.js";

type AgentChannelChatRouteDependencies = AgentChannelRateLimiterDependencies
  & Pick<
    AppDependencies,
    "accessGrantService" | "agentRepository" | "assistantChatService" | "env" | "visitorGeoResolver" | "metricsRegistry" | "logger"
  >;

/**
 * `POST /:agentId/chat` — the REST agent channel. A machine caller holding a
 * REST channel credential runs the bound agent's full turn loop; the credential
 * middleware resolves the workspace and agent, so the route trusts `res.locals`.
 */
export const registerAgentChannelChatRoute = (
  router: Router,
  dependencies: AgentChannelChatRouteDependencies,
): void => {
  const rateLimitRestAgentChat = agentChannelChatRateLimiters(dependencies, "rest");
  const rateLimitRestAgentSource = createAgentChannelSourceRateLimiter(dependencies);

  router.post(
    "/:agentId/chat",
    rateLimitRestAgentSource,
    validateBody(agentChannelChatSchema),
    requireRestAgentChannelCredential(dependencies),
    ...rateLimitRestAgentChat,
    async (req, res, next) => {
      try {
        const { agentChannelGrant } = res.locals as typeof res.locals & AgentChannelCredentialLocals;
        const { context: requestContext, rejection } = resolveConversationRequestContext(dependencies, req);
        if (rejection) {
          recordEdgeFactsProofRejected(dependencies, rejection, req);
        }
        const chatInput = {
          workspaceId: agentChannelGrant.workspaceId,
          agentId: agentChannelGrant.agentId,
          accountId: undefined,
          conversationId: req.body.conversationId,
          message: req.body.message,
          startConversation: req.body.startConversation,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          sourceChannel: "agent_api",
          sourceOrigin: null,
          requestContext,
        };
        if (req.body.stream) {
          onSuccessfulHttpResponse(res, () => dependencies.accessGrantService.recordAgentChannelChatSucceeded({
            grant: agentChannelGrant,
          }));
          await sendChatSse(res, dependencies.assistantChatService.streamAnswer(chatInput));
          return;
        }
        const response = await dependencies.assistantChatService.answer(chatInput);
        onSuccessfulHttpResponse(res, () => dependencies.accessGrantService.recordAgentChannelChatSucceeded({
          grant: agentChannelGrant,
        }));
        if (!response) {
          res.status(204).end();
          return;
        }
        sendChatJson(res, response);
      } catch (error) {
        next(error);
      }
    },
  );
};
