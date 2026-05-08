import { Router } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import { parseBody, parseParams, requirePublicChatSession, requireWorkspaceSession } from "../shared/chatRouteHelpers.js";
import type { AnswerFeedbackActor, EnterpriseAnswerFeedbackService } from "./answerFeedbackService.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const feedbackValueSchema = z.enum(["up", "down"]);
const feedbackBodySchema = z.object({
  value: feedbackValueSchema,
  comment: z.string().trim().max(2000).nullable().optional(),
});
const feedbackParamsSchema = z.object({
  assistantMessageId: z.string().uuid(),
});
const publicFeedbackParamsSchema = feedbackParamsSchema.extend({
  token: z.string().min(1),
});

const getWorkspaceFeedbackActor = (locals: {
  accountId: string;
  authType: "authenticated_user" | "api_token";
  userId?: string;
}): AnswerFeedbackActor =>
  locals.authType === "api_token"
    ? {
        type: "api_token",
        id: locals.accountId,
        accountId: locals.accountId,
      }
    : {
        type: "authenticated_user",
        id: locals.userId ?? locals.accountId,
        accountId: locals.accountId,
        userId: locals.userId,
      };

const getPublicFeedbackActor = (anonymousSessionId: string): AnswerFeedbackActor => ({
  type: "anonymous_user",
  id: anonymousSessionId,
  anonymousSessionId,
});

export const createAnswerFeedbackRoutes = (
  dependencies: RouteDependencies,
  service: EnterpriseAnswerFeedbackService,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const publicChatSession = requirePublicChatSession(dependencies);

  router.put("/messages/:assistantMessageId", workspaceSession, async (req, res, next) => {
    try {
      const params = parseParams(feedbackParamsSchema, req.params);
      const body = parseBody(feedbackBodySchema, req.body);
      const { workspaceId } = res.locals as {
        workspaceId: string;
      };
      const feedback = await service.upsert({
        workspaceId,
        assistantMessageId: params.assistantMessageId,
        value: body.value,
        comment: body.comment,
        actor: getWorkspaceFeedbackActor(res.locals as {
          accountId: string;
          authType: "authenticated_user" | "api_token";
          userId?: string;
        }),
      });
      res.status(200).json(feedback);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/messages/:assistantMessageId", workspaceSession, async (req, res, next) => {
    try {
      const params = parseParams(feedbackParamsSchema, req.params);
      const { workspaceId } = res.locals as {
        workspaceId: string;
      };
      res.status(200).json(await service.clear({
        workspaceId,
        assistantMessageId: params.assistantMessageId,
        actor: getWorkspaceFeedbackActor(res.locals as {
          accountId: string;
          authType: "authenticated_user" | "api_token";
          userId?: string;
        }),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/public/chat/:token/messages/:assistantMessageId", publicChatSession, async (req, res, next) => {
    try {
      const params = parseParams(publicFeedbackParamsSchema, req.params);
      const body = parseBody(feedbackBodySchema, req.body);
      const { workspaceId, anonymousSessionId } = res.locals as {
        workspaceId: string;
        anonymousSessionId: string;
      };
      const feedback = await service.upsert({
        workspaceId,
        assistantMessageId: params.assistantMessageId,
        value: body.value,
        comment: body.comment,
        actor: getPublicFeedbackActor(anonymousSessionId),
      });
      res.status(200).json(feedback);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/public/chat/:token/messages/:assistantMessageId", publicChatSession, async (req, res, next) => {
    try {
      const params = parseParams(publicFeedbackParamsSchema, req.params);
      const { workspaceId, anonymousSessionId } = res.locals as {
        workspaceId: string;
        anonymousSessionId: string;
      };
      res.status(200).json(await service.clear({
        workspaceId,
        assistantMessageId: params.assistantMessageId,
        actor: getPublicFeedbackActor(anonymousSessionId),
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
