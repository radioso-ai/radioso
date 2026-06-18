import { randomUUID } from "node:crypto";
import { Router } from "express";

import type { AppDependencies } from "../../server/types.js";
import { sendChatSse } from "../presenters/chatPresenter.js";
import { AppError, badRequest, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import { resolveAnonymousSession } from "../middleware/resolveAnonymousSession.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { anonymousRateLimiters, publicChatSessionExchangeRateLimiter, type AnonymousRateLimiterDependencies } from "../middleware/anonymousRateLimiter.js";
import { requireSurfaceExtension } from "../shared/requireSurfaceExtension.js";
import { ASSISTANT_LOGO_MIME_TYPES } from "../shared/assistantIdentity.js";
import { validateBody } from "../middleware/validate.js";
import { collectionPageQuerySchema, conversationTailQuerySchema, conversationWindowQuerySchema } from "./conversationRouteSchemas.js";
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
  stripPublicConversationTailCitationArtifacts,
  stripPublicStreamCitationArtifacts,
  websiteEmbedLaunchAllowedAuditEvent,
  websiteEmbedLaunchDeniedAuditEvent,
} from "../presenters/publicChatPresenter.js";

const resolveServedAssistantLogoContentType = (mimeType: string) =>
  ASSISTANT_LOGO_MIME_TYPES.has(mimeType) ? mimeType : "application/octet-stream";

type PublicChatRouteDependencies = AnonymousRateLimiterDependencies & Pick<
  AppDependencies,
  | "env"
  | "agentRepository"
  | "agentService"
  | "agentSurfaceExtensions"
  | "assistantChatService"
  | "auditService"
  | "publicChatActionAdvertiser"
  | "chatHistoryService"
  | "conversationRepository"
  | "documentStorage"
  | "logger"
  | "workspaceRepository"
  | "accountAccessService"
  | "accessGrantService"
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
    dependencies.accessGrantService,
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
  // No Origin header means a same-origin request (the embed widget omits Origin
  // when it is same-origin to the API proxy — see #609→#612), which is allowed.
  // Endpoints that genuinely require an Origin (e.g. website-embed session
  // creation, which binds it) reject the missing header upstream before this runs.
  const websiteEmbedOriginAllowed = (
    websiteEmbed: ReturnType<typeof getWebsiteEmbedSurfaceSettings>,
    origin: string | null,
  ) => origin === null || isAllowedWebsiteEmbedOrigin(websiteEmbed.allowedOrigins, origin);
  const buildAssistantLogoUrl = (req: { get(name: string): string | undefined }, token: string, hasLogo: boolean) =>
    buildPublicAssistantLogoUrl({
      token,
      hasLogo,
      publicChatBaseUrl: dependencies.env.PUBLIC_CHAT_BASE_URL,
      forwardedPrefix: req.get("x-forwarded-prefix"),
    });
  const resolveAgentForPublicLogo = async (launchToken: string) => {
    const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(launchToken);
    if (grant) {
      const agent = await dependencies.agentRepository.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId);
      if (!agent) {
        return null;
      }
      const evaluation = dependencies.accessGrantService.evaluate(grant, {});
      return evaluation.allowed ? agent : null;
    }
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
      const actions = await dependencies.publicChatActionAdvertiser.getPublicIntakeActions(input);
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
      const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(launchToken);
      const agent = grant
        ? await dependencies.agentRepository.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId)
        : await dependencies.agentRepository.findByWebsiteEmbedToken(launchToken);
      const websiteEmbed = agent ? getWebsiteEmbedSurfaceSettings(agent) : null;
      if (!agent || !websiteEmbed?.enabled) {
        next(notFound("Not found"));
        return;
      }
      if (grant) {
        const evaluation = dependencies.accessGrantService.evaluate(grant, { origin });
        if (!evaluation.allowed) {
          await dependencies.accessGrantService.recordAuthFailure({
            grant,
            reason: evaluation.reason,
            surface: "website-embed",
          });
          if (evaluation.reason === "origin_denied") {
            throw badRequest("This website is not approved to host the embedded assistant.");
          }
          next(notFound("Not found"));
          return;
        }
        await dependencies.accessGrantService.touchGrant(grant.id);
      } else if (!websiteEmbedOriginAllowed(websiteEmbed, origin)) {
        await dependencies.accessGrantService.recordAuthFailure({
          workspaceId: agent.workspaceId,
          reason: "origin_denied",
          surface: "website-embed",
        });
        throw badRequest("This website is not approved to host the embedded assistant.");
      }

      // Cacheable per origin: the response varies only by the allow-listed origin
      // (declared via Vary so a CDN keys on it) and not by Accept-Language —
      // built-in locale packs are resolved client-side in the launcher, so `copy`
      // carries only the operator's per-locale packs.
      res.setHeader("Vary", "Origin");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.status(200).json({
        launcherLabel: websiteEmbed.launcherLabel,
        launcherPosition: websiteEmbed.launcherPosition,
        theme: agent.theme,
        branding: agent.branding,
        copy: websiteEmbed.copy,
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
        const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(launchToken);
        const originAllowed = grant
          ? dependencies.accessGrantService.evaluate(grant, { origin }).allowed
          : websiteEmbedOriginAllowed(websiteEmbed, origin);
        if (websiteEmbed.enabled && originAllowed) {
          res.setHeader("Access-Control-Allow-Origin", origin);
        }
      }
      const buffer = await dependencies.documentStorage.read({
        bucket: logo.bucket,
        objectPath: logo.objectPath,
        generation: logo.generation ?? null,
      });
      res.setHeader("Content-Type", resolveServedAssistantLogoContentType(logo.mimeType));
      res.setHeader("Content-Disposition", 'inline; filename="logo"');
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
        const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(launchToken);
        const agentByToken = grant
          ? await dependencies.agentRepository.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId)
          : await dependencies.agentRepository.findByAnonymousChatToken(launchToken);
        const workspace = agentByToken
          ? await dependencies.workspaceRepository.findById(agentByToken.workspaceId)
          : await dependencies.workspaceRepository.findByAnonymousChatToken(launchToken);
        const agent = agentByToken ?? (workspace ? await dependencies.agentService.resolve(workspace.id) : null);
        const grantEvaluation = grant ? dependencies.accessGrantService.evaluate(grant, {}) : null;
        if (!workspace || !agent || !agent.surfaceSettings.anonymousChat.enabled || grantEvaluation?.allowed === false) {
          if (grant && grantEvaluation && !grantEvaluation.allowed) {
            await dependencies.accessGrantService.recordAuthFailure({
              grant,
              reason: grantEvaluation.reason,
              surface: "anonymous-chat",
            });
          }
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
        if (grant) {
          await dependencies.accessGrantService.touchGrant(grant.id);
        }
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

      const grant = await dependencies.accessGrantService.resolvePublicLaunchGrant(launchToken);
      const agentByToken = grant
        ? await dependencies.agentRepository.findByIdAndWorkspaceId(grant.agentId, grant.workspaceId)
        : await dependencies.agentRepository.findByWebsiteEmbedToken(launchToken);
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
      const grantEvaluation = grant
        ? dependencies.accessGrantService.evaluate(grant, { origin })
        : null;
      if (grant && grantEvaluation && !grantEvaluation.allowed && grantEvaluation.reason !== "origin_denied") {
        await dependencies.accessGrantService.recordAuthFailure({
          grant,
          reason: grantEvaluation.reason,
          surface: "website-embed",
        });
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Public chat not found",
          },
        });
        return;
      }
      const originAllowed = grant
        ? grantEvaluation?.allowed === true
        : websiteEmbedOriginAllowed(websiteEmbed, origin);
      if (!originAllowed) {
        await dependencies.accessGrantService.recordAuthFailure({
          grant,
          workspaceId: workspace.id,
          reason: grantEvaluation && !grantEvaluation.allowed ? grantEvaluation.reason : "origin_denied",
          surface: "website-embed",
        });
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
      if (grant) {
        await dependencies.accessGrantService.touchGrant(grant.id);
      }

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
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    ...rateLimitAnonymousChat,
    validateBody(anonymousChatSchema),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId, anonymousSessionId, sourceChannel, sourceOrigin, citationDisplayEnabled } = res.locals as {
          workspaceId: string;
          agentId: string;
          anonymousSessionId: string;
          sourceChannel: string | null;
          sourceOrigin: string | null;
          citationDisplayEnabled: boolean;
        };

        // `startConversation` requests the proactive greeting, which carries no
        // user message. If a message is also present, the caller is starting a
        // conversation *with* that message (a reasonable reading of the flag) —
        // answer the message instead of silently dropping it for an empty
        // greeting. The first message creates the conversation on its own.
        if (req.body.startConversation && !req.body.message) {
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
            // No proactive greeting to emit (e.g. bootstrap is inactive for this
            // agent). This is a benign "no content" outcome, not a failure: the
            // website embed client treats 204 as "no greeting" and proceeds to
            // normal chat. CORS headers are already set by the public-session
            // middleware, so the browser can read this response.
            res.status(204).end();
            return;
          }
          res.status(200).json(stripPublicChatCitationArtifacts(bootstrap, citationDisplayEnabled));
          return;
        }

        const input = {
          workspaceId,
          agentId,
          message: req.body.message!,
          stream: req.body.stream,
          userExpectedLocale: req.body.userExpectedLocale,
          conversationId: req.body.conversationId,
          bootstrapGreetingId: req.body.bootstrapGreetingId,
          inputMetadata: req.body.inputMetadata,
          pageContext: req.body.pageContext,
          sourceChannel,
          anonymousSessionId,
          sourceOrigin,
        };

        if (input.stream) {
          await sendChatSse(res, stripPublicStreamCitationArtifacts(dependencies.assistantChatService.streamAnswer(input), citationDisplayEnabled));
        } else {
          const result = await dependencies.assistantChatService.answer(input);
          if (!result) {
            throw serviceUnavailable("Public chat response is unavailable.", {
              code: "public_chat_empty_response",
            });
          }
          res.status(200).json(stripPublicChatCitationArtifacts(result, citationDisplayEnabled));
        }
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /api/v1/public/chat/:token — list conversations for this anonymous session
  router.get("/:token", sessionMiddleware, requirePublicChatPermission(dependencies, "public_chat.session.read.own"), async (req, res, next) => {
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
        assistantLinkUtmEnabled: Boolean((res.locals as { assistantLinkUtmEnabled?: boolean }).assistantLinkUtmEnabled ?? true),
        citationDisplayEnabled: Boolean((res.locals as { citationDisplayEnabled?: boolean }).citationDisplayEnabled ?? true),
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

  // GET /api/v1/public/chat/:token/tail/:conversationId — poll new messages for this anonymous session
  router.get("/:token/tail/:conversationId", sessionMiddleware, requirePublicChatPermission(dependencies, "public_chat.history.read.own"), async (req, res, next) => {
    try {
      const { agentId, anonymousSessionId, citationDisplayEnabled } = res.locals as { agentId: string; anonymousSessionId: string; citationDisplayEnabled: boolean };
      const parsedParams = publicConversationParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        next(badRequest("Invalid request params", parsedParams.error.flatten()));
        return;
      }
      const parsedQuery = conversationTailQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        next(badRequest("Invalid request query", parsedQuery.error.flatten()));
        return;
      }
      const { conversationId } = parsedParams.data;

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

      const tail = await dependencies.chatHistoryService.tailConversation(
        conversation.workspaceId,
        conversationId,
        parsedQuery.data,
      );
      res.status(200).json(stripPublicConversationTailCitationArtifacts(tail, citationDisplayEnabled));
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/public/chat/:token/history/:conversationId — get conversation detail
  router.get("/:token/history/:conversationId", sessionMiddleware, requirePublicChatPermission(dependencies, "public_chat.history.read.own"), async (req, res, next) => {
    try {
      const { agentId, anonymousSessionId, citationDisplayEnabled } = res.locals as { agentId: string; anonymousSessionId: string; citationDisplayEnabled: boolean };
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
      res.status(200).json(stripPublicConversationCitationArtifacts(detail, anonymousSessionId, citationDisplayEnabled));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
