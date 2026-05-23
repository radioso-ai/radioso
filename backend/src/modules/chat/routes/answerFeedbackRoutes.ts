import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../../app/server/types.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../../../app/http/middleware/requireWorkspaceSession.js";
import { validateBody } from "../../../app/http/middleware/validate.js";
import { resolveAnonymousSession } from "../../../app/http/middleware/resolveAnonymousSession.js";
import { resolvePublicChatSessionSecret } from "../../../app/http/shared/publicChatSessionSecret.js";
import { badRequest } from "../../../shared/domain/errors.js";
import type { AnswerFeedbackActor } from "../services/answerFeedbackService.js";
import type { AnswerFeedbackService } from "../services/answerFeedbackService.js";

export interface AnswerFeedbackRouteDependencies {
  env: Pick<AppDependencies["env"],
    | "NODE_ENV"
    | "PUBLIC_CHAT_SESSION_SECRET"
    | "SESSION_COOKIE_NAME"
    | "SESSION_COOKIE_SECRET"
    | "WORKSPACE_TOKEN_SECRET"
  >;
  authService: {
    authenticateSession(token: string): Promise<{ accountId: string; userId: string; sessionId: string }>;
    authenticateApiToken(token: string): Promise<{
      accountId: string;
      workspaceId: string;
      principal: unknown;
    }>;
  };
  accountAccessService: {
    requireActiveMembership(accountId: string, userId: string): Promise<unknown>;
  };
  workspaceSessionService: {
    resolve(input: { accountId: string; workspaceId?: string | null }): Promise<{ accountId: string; workspaceId: string }>;
  };
  workspaceRepository: Pick<AppDependencies["workspaceRepository"],
    "findByAnonymousChatToken" | "findByWebsiteEmbedToken" | "findById"
  >;
  agentRepository: Pick<AppDependencies["agentRepository"], "findByAnonymousChatToken" | "findByWebsiteEmbedToken">;
  agentService?: Pick<AppDependencies["agentService"], "resolve">;
}

const feedbackBodySchema = z.object({
  value: z.enum(["up", "down"]),
  comment: z.string().trim().max(2000).nullable().optional(),
});

const feedbackParamsSchema = z.object({
  assistantMessageId: z.string().uuid(),
});

const publicFeedbackParamsSchema = feedbackParamsSchema.extend({
  token: z.string().min(1),
});

const parseParams = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw badRequest("Invalid request params", parsed.error.flatten());
};

const getWorkspaceFeedbackActor = (locals: {
  accountId: string;
  authMode: "session" | "bearer";
  userId?: string;
}): AnswerFeedbackActor =>
  locals.authMode === "bearer"
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
  dependencies: AnswerFeedbackRouteDependencies,
  service: AnswerFeedbackService,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies as unknown as WorkspaceSessionDependencies);
  const publicSession = resolveAnonymousSession(
    dependencies.workspaceRepository,
    resolvePublicChatSessionSecret(dependencies.env),
    dependencies.env.SESSION_COOKIE_SECRET,
    dependencies.agentRepository,
    dependencies.agentService,
  );

  router.put("/messages/:assistantMessageId", workspaceSession, validateBody(feedbackBodySchema), async (req, res, next) => {
    try {
      const params = parseParams(feedbackParamsSchema, req.params);
      const { workspaceId } = res.locals as {
        workspaceId: string;
      };
      const feedback = await service.upsert({
        workspaceId,
        assistantMessageId: params.assistantMessageId,
        value: req.body.value,
        comment: req.body.comment,
        actor: getWorkspaceFeedbackActor(res.locals as {
          accountId: string;
          authMode: "session" | "bearer";
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
          authMode: "session" | "bearer";
          userId?: string;
        }),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/public/chat/:token/messages/:assistantMessageId", publicSession, validateBody(feedbackBodySchema), async (req, res, next) => {
    try {
      const params = parseParams(publicFeedbackParamsSchema, req.params);
      const { workspaceId, agentId, anonymousSessionId } = res.locals as {
        workspaceId: string;
        agentId?: string | null;
        anonymousSessionId: string;
      };
      const feedback = await service.upsert({
        workspaceId,
        agentId,
        assistantMessageId: params.assistantMessageId,
        value: req.body.value,
        comment: req.body.comment,
        actor: getPublicFeedbackActor(anonymousSessionId),
      });
      res.status(200).json(feedback);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/public/chat/:token/messages/:assistantMessageId", publicSession, async (req, res, next) => {
    try {
      const params = parseParams(publicFeedbackParamsSchema, req.params);
      const { workspaceId, agentId, anonymousSessionId } = res.locals as {
        workspaceId: string;
        agentId?: string | null;
        anonymousSessionId: string;
      };
      res.status(200).json(await service.clear({
        workspaceId,
        agentId,
        assistantMessageId: params.assistantMessageId,
        actor: getPublicFeedbackActor(anonymousSessionId),
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
