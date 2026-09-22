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
import { presentChatPayload, sendChatJson, sendChatSse } from "../presenters/chatPresenter.js";
import { recordEdgeFactsProofRejected, resolveConversationRequestContext } from "../shared/conversationRequestContext.js";
import { agentChannelChatSchema } from "../schemas/agentChannelSchemas.js";
import {
  buildAgentReplyEnvelope,
  chatRequestInputFor,
  isChatTurnResponse,
  resolveAgentTurnInput,
  type AgentTurnInput,
} from "../../../modules/chat/contracts/index.js";

type AgentChannelChatRouteDependencies = AgentChannelRateLimiterDependencies
  & Pick<
    AppDependencies,
    | "accessGrantService"
    | "agentRepository"
    | "agentToolCatalog"
    | "assistantChatService"
    | "conversationRepository"
    | "env"
    | "visitorGeoResolver"
    | "metricsRegistry"
    | "logger"
  >;

const pinnedRevisionIdFor = async (
  dependencies: Pick<AgentChannelChatRouteDependencies, "conversationRepository">,
  workspaceId: string,
  conversationId: string | undefined,
): Promise<string | undefined> => {
  if (!conversationId) {
    return undefined;
  }
  const conversation = await dependencies.conversationRepository.findByIdAndWorkspaceId(conversationId, workspaceId);
  return conversation?.agentRevisionId ?? undefined;
};

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
        // A tool call is validated against the catalog of the release the
        // conversation is pinned to, before any turn state is written.
        const turnInput: AgentTurnInput | null = req.body.startConversation
          ? null
          : await resolveAgentTurnInput(dependencies.agentToolCatalog, {
              workspaceId: agentChannelGrant.workspaceId,
              agentId: agentChannelGrant.agentId,
              agentRevisionId: await pinnedRevisionIdFor(dependencies, agentChannelGrant.workspaceId, req.body.conversationId),
              body: req.body,
            }, { metrics: dependencies.metricsRegistry, logger: dependencies.logger });
        const chatInput = {
          workspaceId: agentChannelGrant.workspaceId,
          agentId: agentChannelGrant.agentId,
          accountId: undefined,
          conversationId: req.body.conversationId,
          ...(turnInput ? chatRequestInputFor(turnInput) : {}),
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
          await sendChatSse(res, dependencies.assistantChatService.streamAnswer(chatInput), { agentEnvelope: true });
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
        // A bootstrap greeting (`startConversation`) has no turn, so no envelope.
        if (!isChatTurnResponse(response)) {
          sendChatJson(res, response);
          return;
        }
        res.status(200).json({
          ...presentChatPayload(response),
          citations: response.citations ?? [],
          ...buildAgentReplyEnvelope(response),
        });
      } catch (error) {
        next(error);
      }
    },
  );
};
