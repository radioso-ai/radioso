import { randomUUID } from "node:crypto";
import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { sendChatSse } from "../presenters/chatPresenter.js";
import { AppError, badRequest, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import { resolveAnonymousSession } from "../middleware/resolveAnonymousSession.js";
import { anonymousRateLimiters, publicChatSessionExchangeRateLimiter, type AnonymousRateLimiterDependencies } from "../middleware/anonymousRateLimiter.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { collectionPageQuerySchema, conversationWindowQuerySchema } from "./conversationRouteSchemas.js";
import { isAllowedWebsiteEmbedOrigin } from "../../../shared/domain/websiteEmbed.js";
import { getWebsiteEmbedSurfaceSettings } from "../../../modules/agents/public.js";
import {
  issuePublicChatResumeToken,
  issuePublicChatSession,
  type PublicChatResumePayload,
  verifyPublicChatResumeToken,
} from "../../../modules/settings/contracts/publicChatSession.js";
import { buildPublicAssistantLogoUrl } from "../shared/assistantLogoUrl.js";
import { resolvePublicChatSessionSecret } from "../shared/publicChatSessionSecret.js";
import {
  anonymousChatSchema,
  publicChatSessionSchema,
  publicConversationParamsSchema,
} from "./publicChatRouteSchemas.js";
import {
  presentPublicChatSession,
  stripPublicChatCitationArtifacts,
  stripPublicConversationCitationArtifacts,
  stripPublicStreamCitationArtifacts,
  websiteEmbedLaunchAllowedAuditEvent,
  websiteEmbedLaunchDeniedAuditEvent,
} from "../presenters/publicChatPresenter.js";

type PublicChatRouteDependencies = AnonymousRateLimiterDependencies & Pick<
  AppDependencies,
  | "env"
  | "agentRepository"
  | "agentService"
  | "agentSurfaceExtensions"
  | "assistantChatService"
  | "auditService"
  | "chatIntakeProvider"
  | "chatHistoryService"
  | "conversationRepository"
  | "documentStorage"
  | "logger"
  | "workspaceRepository"
>;

export const createPublicChatRoutes = (dependencies: PublicChatRouteDependencies): Router => {
  const router = Router();
  const publicChatSessionSecret = resolvePublicChatSessionSecret(dependencies.env);
  const sessionMiddleware = resolveAnonymousSession(
    dependencies.workspaceRepository,
    publicChatSessionSecret,
    dependencies.env.SESSION_COOKIE_SECRET,
    dependencies.agentRepository,
    dependencies.agentService,
  );
  const rateLimitAnonymousChat = anonymousRateLimiters(dependencies);
  const rateLimitPublicChatSessionExchange = publicChatSessionExchangeRateLimiter(dependencies);
  const resolveOrigin = (value: string | undefined) => {
    if (!value) {
      return null;
    }

    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const buildAssistantLogoUrl = (req: { get(name: string): string | undefined }, token: string, hasLogo: boolean) =>
    buildPublicAssistantLogoUrl({
      token,
      hasLogo,
      publicChatBaseUrl: dependencies.env.PUBLIC_CHAT_BASE_URL,
      forwardedPrefix: req.get("x-forwarded-prefix"),
    });
  const resolveAgentForPublicLogo = async (launchToken: string) => {
    const anonymousAgent = await dependencies.agentRepository.findByAnonymousChatToken(launchToken);
    if (anonymousAgent?.surfaceSettings.anonymousChat.enabled) {
      return anonymousAgent;
    }
    const embedAgent = await dependencies.agentRepository.findByWebsiteEmbedToken(launchToken);
    if (embedAgent && getWebsiteEmbedSurfaceSettings(embedAgent).enabled) {
      return embedAgent;
    }
    return null;
  };
  const resolvePublicIntakeActions = async (input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
  }) => {
    try {
      const actions = await dependencies.chatIntakeProvider.getPublicIntakeActions?.(input);
      return actions && actions.length > 0 ? actions : undefined;
    } catch (error) {
      dependencies.logger.warn?.(
        { err: error instanceof Error ? error.message : String(error), workspaceId: input.workspaceId },
        "Failed to resolve public chat intake actions",
      );
      return undefined;
    }
  };
  const resolveResumedSessionId = (input: {
    resume: PublicChatResumePayload | null;
    workspaceId: string;
    agentId: string;
    sourceChannel: "anonymous" | "website_embed";
    sourceOrigin: string | null;
  }) => {
    if (!input.resume) {
      return randomUUID();
    }

    if (
      input.resume.workspaceId !== input.workspaceId ||
      input.resume.agentId !== input.agentId ||
      input.resume.sourceChannel !== input.sourceChannel ||
      input.resume.sourceOrigin !== input.sourceOrigin
    ) {
      throw badRequest("Invalid public chat session request");
    }

    return input.resume.publicSessionId;
  };

  router.get("/:token/embed-config", requireSurfaceExtension(dependencies.agentSurfaceExtensions, "websiteEmbed"), async (req, res, next) => {
    try {
      const launchToken = String(req.params.token);
      const origin = resolveOrigin(req.header("origin"));
      const agent = await dependencies.agentRepository.findByWebsiteEmbedToken(launchToken);
      const websiteEmbed = agent ? getWebsiteEmbedSurfaceSettings(agent) : null;
      if (!agent || !websiteEmbed?.enabled) {
        next(notFound("Not found"));
        return;
      }
      if (origin && !isAllowedWebsiteEmbedOrigin(websiteEmbed.allowedOrigins, origin)) {
        throw badRequest("This website is not approved to host the embedded assistant.");
      }

      // Ask the website-embed extension for a built-in translation pack
      // matching the visitor's Accept-Language. Operator's per-locale packs
      // still win because they're merged AFTER under the locale's own key.
      const extension = dependencies.agentSurfaceExtensions.get("websiteEmbed");
      const localizedDefault = extension?.resolveCopyForAcceptLanguage?.(req.header("accept-language") ?? null);
      const copyResponse = localizedDefault
        ? { ...websiteEmbed.copy, default: localizedDefault.pack }
        : websiteEmbed.copy;

      res.status(200).json({
        launcherLabel: websiteEmbed.launcherLabel,
        launcherPosition: websiteEmbed.launcherPosition,
        theme: agent.theme,
        branding: agent.branding,
        copy: copyResponse,
        expertOverrides: websiteEmbed.expertOverrides,
        assistantLogoUrl: buildAssistantLogoUrl(req, launchToken, Boolean(agent.logo)),
        proactiveGreetingEnabled: agent.proactiveGreetingEnabled,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:token/assistant-logo", async (req, res, next) => {
    try {
      const launchToken = String(req.params.token);
      const agent = await resolveAgentForPublicLogo(launchToken);
      const logo = agent?.logo;
      if (!agent || !logo) {
        next(notFound("Not found"));
        return;
      }
      const origin = resolveOrigin(req.header("origin"));
      if (origin) {
        res.vary("Origin");
        const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
        if (websiteEmbed.enabled && isAllowedWebsiteEmbedOrigin(websiteEmbed.allowedOrigins, origin)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
        }
      }
      const buffer = await dependencies.documentStorage.read({
        bucket: logo.bucket,
        objectPath: logo.objectPath,
        generation: logo.generation ?? null,
      });
      res.setHeader("Content-Type", logo.mimeType);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.status(200).send(buffer);
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/public/chat/:token/sessions — exchange a public launch token for a chat session
  router.post("/:token/sessions", validateBody(publicChatSessionSchema), rateLimitPublicChatSessionExchange, async (req, res, next) => {
    try {
      const sessionSecret = publicChatSessionSecret;
      if (!sessionSecret) {
        throw serviceUnavailable("Public chat sessions are not configured.", {
          missingEnv: "PUBLIC_CHAT_SESSION_SECRET",
        });
      }

      const launchToken = String(req.params.token);
      const origin = resolveOrigin(req.header("origin"));
      const resumeToken = req.body.resumeToken;
      const resume = resumeToken
        ? verifyPublicChatResumeToken(resumeToken, sessionSecret, launchToken)
        : null;
      if (resumeToken && !resume) {
        throw badRequest("Invalid public chat session request");
      }

      if (req.body.channel === "anonymous_link") {
        const agentByToken = await dependencies.agentRepository.findByAnonymousChatToken(launchToken);
        const workspace = agentByToken
          ? await dependencies.workspaceRepository.findById(agentByToken.workspaceId)
          : await dependencies.workspaceRepository.findByAnonymousChatToken(launchToken);
        const agent = agentByToken ?? (workspace ? await dependencies.agentService.resolve(workspace.id) : null);
        if (!workspace || !agent || !agent.surfaceSettings.anonymousChat.enabled) {
          res.status(404).json({
            error: {
              code: "not_found",
              message: "Public chat not found",
            },
          });
          return;
        }
        const publicChatToken = agent.surfaceSettings.anonymousChat.token;
        if (typeof publicChatToken !== "string") {
          res.status(404).json({
            error: {
              code: "not_found",
              message: "Public chat not found",
            },
          });
          return;
        }

        const publicSessionId = resolveResumedSessionId({
          resume,
          workspaceId: workspace.id,
          agentId: agent.id,
          sourceChannel: "anonymous",
          sourceOrigin: null,
        });
        const session = issuePublicChatSession(sessionSecret, {
          workspaceId: workspace.id,
          agentId: agent.id,
          publicChatToken,
          publicSessionId,
          sourceChannel: "anonymous",
          sourceOrigin: null,
        });
        const resumeSession = issuePublicChatResumeToken(sessionSecret, {
          workspaceId: workspace.id,
          agentId: agent.id,
          publicChatToken,
          publicSessionId,
          sourceChannel: "anonymous",
          sourceOrigin: null,
        });

        res.status(200).json(presentPublicChatSession({
          agent,
          workspaceName: workspace.name,
          publicChatToken,
          session,
          resume: resumeSession,
          assistantAvatarUrl: buildAssistantLogoUrl(req, publicChatToken, Boolean(agent.logo)),
          intakeActions: await resolvePublicIntakeActions({
            workspaceId: workspace.id,
            agentId: agent.id,
            sourceChannel: "anonymous",
          }),
        }));
        return;
      }

      if (!origin) {
        res.status(400).json({
          error: {
            code: "bad_request",
            message: "Invalid public chat session request",
          },
        });
        return;
      }

      const agentByToken = await dependencies.agentRepository.findByWebsiteEmbedToken(launchToken);
      const workspace = agentByToken
        ? await dependencies.workspaceRepository.findById(agentByToken.workspaceId)
        : await dependencies.workspaceRepository.findByWebsiteEmbedToken(launchToken);
      if (!workspace) {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      let agent = agentByToken;
      if (!agent) {
        try {
          agent = await dependencies.agentService.resolve(workspace.id);
        } catch (error) {
          if (error instanceof AppError && error.statusCode === 404) {
            res.status(404).json({
              error: {
                code: "not_found",
                message: "Public chat not found",
              },
            });
            return;
          }
          throw error;
        }
      }

      if (!agent) {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
      if (!isAllowedWebsiteEmbedOrigin(websiteEmbed.allowedOrigins, origin)) {
        await dependencies.auditService.record(websiteEmbedLaunchDeniedAuditEvent({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          origin,
        }));

        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This website is not approved to host the embedded assistant.",
          },
        });
        return;
      }

      if (!websiteEmbed.enabled) {
        await dependencies.auditService.record(websiteEmbedLaunchDeniedAuditEvent({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          origin,
          reason: "embed_disabled",
        }));

        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      await dependencies.auditService.record(websiteEmbedLaunchAllowedAuditEvent({
        accountId: workspace.accountId,
        workspaceId: workspace.id,
        origin,
      }));

      const publicChatToken = websiteEmbed.token;
      if (typeof publicChatToken !== "string") {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      const publicSessionId = resolveResumedSessionId({
        resume,
        workspaceId: workspace.id,
        agentId: agent.id,
        sourceChannel: "website_embed",
        sourceOrigin: origin,
      });
      const session = issuePublicChatSession(sessionSecret, {
        workspaceId: workspace.id,
        agentId: agent.id,
        publicChatToken,
        publicSessionId,
        sourceChannel: "website_embed",
        sourceOrigin: origin,
      });
      const resumeSession = issuePublicChatResumeToken(sessionSecret, {
        workspaceId: workspace.id,
        agentId: agent.id,
        publicChatToken,
        publicSessionId,
        sourceChannel: "website_embed",
        sourceOrigin: origin,
      });

      res.status(200).json(presentPublicChatSession({
        agent,
        workspaceName: workspace.name,
        publicChatToken,
        session,
        resume: resumeSession,
        assistantAvatarUrl: buildAssistantLogoUrl(req, publicChatToken, Boolean(agent.logo)),
        intakeActions: await resolvePublicIntakeActions({
          workspaceId: workspace.id,
          agentId: agent.id,
          sourceChannel: "website_embed",
        }),
      }));
    } catch (error) {
      next(error);
    }
  });

  // POST /api/v1/public/chat/:token — send a message
  router.post(
    "/:token",
    sessionMiddleware,
    ...rateLimitAnonymousChat,
    validateBody(anonymousChatSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
          workspaceId: string;
          agentId: string;
          anonymousSessionId: string;
          sourceChannel: string | null;
          sourceOrigin: string | null;
        };

        if (req.body.startConversation) {
          const bootstrap = await dependencies.assistantChatService.answer({
            workspaceId,
            agentId,
            startConversation: true,
            stream: false,
            sourceChannel,
            anonymousSessionId,
            sourceOrigin,
            userExpectedLocale: req.body.userExpectedLocale,
            pageContext: req.body.pageContext,
          });
          if (!bootstrap) {
            res.status(204).end();
            return;
          }
          res.status(200).json(stripPublicChatCitationArtifacts(bootstrap));
          return;
        }

        const input = {
          workspaceId,
          agentId,
          message: req.body.message!,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          conversationId: req.body.conversationId,
          inputMetadata: req.body.inputMetadata,
          pageContext: req.body.pageContext,
          sourceChannel,
          anonymousSessionId,
          sourceOrigin,
        };

        if (input.stream) {
          await sendChatSse(res, stripPublicStreamCitationArtifacts(dependencies.assistantChatService.streamAnswer(input)));
        } else {
          const result = await dependencies.assistantChatService.answer(input);
          if (!result) {
            res.status(204).end();
            return;
          }
          res.status(200).json(stripPublicChatCitationArtifacts(result));
        }
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /api/v1/public/chat/:token — list conversations for this anonymous session
  router.get("/:token", sessionMiddleware, async (req, res, next) => {
    try {
      const { workspaceId, agentId, workspaceName, anonymousSessionId } = res.locals as {
        workspaceId: string;
        agentId: string;
        workspaceName: string;
        anonymousSessionId: string;
      };
      const parsedQuery = collectionPageQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const page = await dependencies.chatHistoryService.listAnonymousConversations(
        workspaceId,
        anonymousSessionId,
        {
          ...parsedQuery.data,
          agentId,
        },
      );

      res.status(200).json({
        workspaceName,
        assistantAvatarUrl: buildAssistantLogoUrl(req, String(req.params.token), Boolean((res.locals as { assistantLogoAvailable?: boolean }).assistantLogoAvailable)),
        theme: (res.locals as { assistantTheme?: unknown }).assistantTheme,
        branding: (res.locals as { assistantBranding?: unknown }).assistantBranding,
        assistantBootstrapActive: Boolean((res.locals as { assistantBootstrapActive?: boolean }).assistantBootstrapActive),
        intakeActions: await resolvePublicIntakeActions({
          workspaceId,
          agentId,
          sourceChannel: (res.locals as { sourceChannel?: string | null }).sourceChannel,
        }),
        ...page,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/public/chat/:token/history/:conversationId — get conversation detail
  router.get("/:token/history/:conversationId", sessionMiddleware, async (req, res, next) => {
    try {
      const { agentId, anonymousSessionId } = res.locals as { agentId: string; anonymousSessionId: string };
      const parsedParams = publicConversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = conversationWindowQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;

      // Verify the conversation belongs to this anonymous session, not just the workspace
      const conversation = await dependencies.conversationRepository.findByIdAndAnonymousSession(
        conversationId,
        res.locals.workspaceId as string,
        anonymousSessionId,
        agentId,
      );
      if (!conversation) {
        res.status(404).json({ error: { code: "not_found", message: "Conversation not found" } });
        return;
      }

      const detail = await dependencies.chatHistoryService.getConversation(
        conversation.workspaceId,
        conversationId,
        parsedQuery.data,
        { includeAnswerFeedback: true },
      );
      res.status(200).json(stripPublicConversationCitationArtifacts(detail, anonymousSessionId));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
