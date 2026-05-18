import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { sendChatSse } from "../presenters/chatPresenter.js";
import { AppError, badRequest, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import { resolveAnonymousSession } from "../middleware/resolveAnonymousSession.js";
import { anonymousRateLimiters, publicChatSessionExchangeRateLimiter, type AnonymousRateLimiterDependencies } from "../middleware/anonymousRateLimiter.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { validateBody } from "../middleware/validate.js";
import { collectionPageQuerySchema, conversationWindowQuerySchema } from "./conversationRouteSchemas.js";
import { isAllowedWebsiteEmbedOrigin } from "../../../modules/settings/contracts/websiteEmbed.js";
import { getWebsiteEmbedSurfaceSettings, isAgentBootstrapActive, resolveAgentDisplayName } from "../../../modules/agents/public.js";
import { issuePublicChatSession } from "../../../modules/settings/contracts/publicChatSession.js";
import { buildPublicAssistantLogoUrl } from "../shared/assistantLogoUrl.js";

const localeHintSchema = z.string().trim().max(35);
const pageContextSchema = z.object({
  pageUrl: z.string().trim().max(2048).nullable().optional(),
  pageTitle: z.string().trim().max(180).nullable().optional(),
  pageLocale: z.string().trim().max(35).nullable().optional(),
  browserLocale: z.string().trim().max(35).nullable().optional(),
  content: z.string().trim().max(6000).nullable().optional(),
}).optional();

export const anonymousChatSchema = z.object({
  message: z.string().min(1).optional(),
  stream: z.boolean().default(false),
  conversationId: z.string().uuid().optional(),
  startConversation: z.boolean().optional(),
  userExpectedLocale: localeHintSchema.optional(),
  pageContext: pageContextSchema,
  inputMetadata: z.object({
    method: z.enum(["typed", "suggestion_click", "intent_click"]),
    suggestionSourceMessageId: z.string().uuid().optional(),
    intent: z.object({
      skillName: z.string().trim().min(1).max(120),
      intentName: z.string().trim().min(1).max(120).optional(),
    }).optional(),
  }).superRefine((value, ctx) => {
    if (value.method === "suggestion_click" && !value.suggestionSourceMessageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "suggestionSourceMessageId is required for suggestion_click",
        path: ["suggestionSourceMessageId"],
      });
    }
    if (value.method === "intent_click" && !value.intent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "intent is required for intent_click",
        path: ["intent"],
      });
    }
  }).optional(),
}).superRefine((value, ctx) => {
  if (!value.message && !value.startConversation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "message is required unless startConversation is true",
      path: ["message"],
    });
  }
  if (value.startConversation && value.conversationId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startConversation may only be used for brand-new conversations",
      path: ["conversationId"],
    });
  }
});

export const publicConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const publicChatSessionSchema = z.object({
  channel: z.enum(["anonymous_link", "website_embed"]),
  agentId: z.string().uuid().optional(),
  anonymousSessionId: z.string().uuid().optional(),
  pageContext: pageContextSchema,
});

const resolvePublicChatSessionSecret = (env: {
  NODE_ENV: string;
  PUBLIC_CHAT_SESSION_SECRET?: string;
  WORKSPACE_TOKEN_SECRET?: string;
}) => {
  if (env.PUBLIC_CHAT_SESSION_SECRET) {
    return env.PUBLIC_CHAT_SESSION_SECRET;
  }

  // Local Docker/dev setups already require WORKSPACE_TOKEN_SECRET; use it as a dev-only fallback
  // so public chat works out of the box without weakening deployed environments.
  if (env.NODE_ENV === "development") {
    return env.WORKSPACE_TOKEN_SECRET;
  }

  return undefined;
};

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
      const requestedSessionId = req.body.anonymousSessionId ?? randomUUID();

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
        if (!publicChatToken) {
          res.status(404).json({
            error: {
              code: "not_found",
              message: "Public chat not found",
            },
          });
          return;
        }

        const session = issuePublicChatSession(sessionSecret, {
          workspaceId: workspace.id,
          agentId: agent.id,
          publicChatToken,
          publicSessionId: requestedSessionId,
          sourceChannel: "anonymous",
          sourceOrigin: null,
        });

        res.status(200).json({
          workspaceName: resolveAgentDisplayName({
            agentName: agent.name,
            workspaceName: workspace.name,
          }),
          agentId: agent.id,
          agentName: agent.name,
          publicChatToken,
          publicSessionId: session.publicSessionId,
          publicSessionToken: session.token,
          assistantBootstrapActive: isAgentBootstrapActive(agent),
          assistantAvatarUrl: buildAssistantLogoUrl(req, publicChatToken, Boolean(agent.logo)),
          theme: agent.theme,
          branding: agent.branding,
          intakeActions: await resolvePublicIntakeActions({
            workspaceId: workspace.id,
            agentId: agent.id,
            sourceChannel: "anonymous",
          }),
          expiresAt: session.expiresAt,
        });
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
        await dependencies.auditService.record({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          eventType: "website_embed.launch_denied",
          eventStatus: "failure",
          metadata: { origin },
        });

        res.status(403).json({
          error: {
            code: "forbidden",
            message: "This website is not approved to host the embedded assistant.",
          },
        });
        return;
      }

      if (!websiteEmbed.enabled) {
        await dependencies.auditService.record({
          accountId: workspace.accountId,
          workspaceId: workspace.id,
          eventType: "website_embed.launch_denied",
          eventStatus: "failure",
          metadata: {
            origin,
            reason: "embed_disabled",
          },
        });

        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      await dependencies.auditService.record({
        accountId: workspace.accountId,
        workspaceId: workspace.id,
        eventType: "website_embed.launch_allowed",
        eventStatus: "success",
        metadata: { origin },
      });

      const publicChatToken = websiteEmbed.token;
      if (!publicChatToken) {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }

      const session = issuePublicChatSession(sessionSecret, {
        workspaceId: workspace.id,
        agentId: agent.id,
        publicChatToken,
        publicSessionId: requestedSessionId,
        sourceChannel: "website_embed",
        sourceOrigin: origin,
      });

      res.status(200).json({
        workspaceName: resolveAgentDisplayName({
          agentName: agent.name,
          workspaceName: workspace.name,
        }),
        agentId: agent.id,
        agentName: agent.name,
        publicChatToken,
        publicSessionId: session.publicSessionId,
        publicSessionToken: session.token,
        assistantBootstrapActive: isAgentBootstrapActive(agent),
        assistantAvatarUrl: buildAssistantLogoUrl(req, publicChatToken, Boolean(agent.logo)),
        theme: agent.theme,
        branding: agent.branding,
        intakeActions: await resolvePublicIntakeActions({
          workspaceId: workspace.id,
          agentId: agent.id,
          sourceChannel: "website_embed",
        }),
        expiresAt: session.expiresAt,
      });
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
          res.status(200).json(bootstrap);
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
          await sendChatSse(res, dependencies.assistantChatService.streamAnswer(input));
        } else {
          const result = await dependencies.assistantChatService.answer(input);
          res.status(200).json(result);
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
      res.status(200).json(detail);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
