import type { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
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
import { registerOpenAiCompletionsRoute } from "../../../modules/voiceChannel/public.js";

type AgentVoiceRouteDependencies = AgentChannelRateLimiterDependencies
  & Pick<AppDependencies, "accessGrantService" | "agentRepository" | "logger" | "voiceTurns">;

const grantOf = (locals: object) => (locals as AgentChannelCredentialLocals).agentChannelGrant;

/**
 * Mounts the voice vendor adapters behind the REST agent channel's credential and turn budget: a
 * voice runtime holds an `agent-api` credential for one agent, and its turns spend that
 * credential's budget like any other REST agent turn.
 */
export const registerAgentVoiceRoutes = (router: Router, dependencies: AgentVoiceRouteDependencies): void => {
  registerOpenAiCompletionsRoute(router, {
    turns: dependencies.voiceTurns,
    logger: dependencies.logger,
    admission: {
      handlers: [
        createAgentChannelSourceRateLimiter(dependencies),
        requireRestAgentChannelCredential(dependencies),
        ...agentChannelChatRateLimiters(dependencies, "rest"),
      ],
      callerOf: (res) => {
        const grant = grantOf(res.locals);
        return { workspaceId: grant.workspaceId, agentId: grant.agentId };
      },
      onTurnAccepted: (res) => {
        const grant = grantOf(res.locals);
        onSuccessfulHttpResponse(res, () => dependencies.accessGrantService.recordAgentChannelChatSucceeded({ grant }));
      },
    },
  });
};
