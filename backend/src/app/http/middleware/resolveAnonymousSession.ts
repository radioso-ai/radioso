import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { AppError, notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentRecord, AgentService } from "../../../modules/agents/public.js";
import { isAgentBootstrapActive } from "../../../modules/agents/public.js";
import {
  resolveAssistantDisplayName,
} from "../../../modules/settings/contracts/assistantBootstrap.js";
import { defaultWebsiteEmbedSettings } from "../../../modules/settings/contracts/websiteEmbed.js";
import { verifyPublicChatSession } from "../../../modules/settings/contracts/publicChatSession.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const ANONYMOUS_SESSION_HEADER = "x-radioso-anonymous-session";
export const PUBLIC_CHAT_SESSION_HEADER = "x-radioso-public-session";
export const PUBLIC_CHAT_SESSION_ID_HEADER = "x-radioso-public-session-id";
const ANONYMOUS_RATE_LIMIT_COOKIE_PREFIX = "anon_rate_limit_";
const anonymousTokenParamsSchema = z.object({
  token: z.string().min(1),
});

type PublicSessionAgent = Pick<AgentRecord, "id" | "workspaceId" | "name" | "logo" | "theme" | "proactiveGreetingEnabled" | "surfaceSettings">;

const isLoopbackHost = (host: string | undefined) => {
  if (!host) {
    return false;
  }

  const normalizedHost = host.trim().toLowerCase();
  const withoutPort = normalizedHost.startsWith("[")
    ? normalizedHost.slice(0, normalizedHost.indexOf("]") + 1)
    : normalizedHost.split(":")[0];

  return withoutPort === "localhost" || withoutPort === "127.0.0.1" || withoutPort === "[::1]";
};

export const shouldUseSecureAnonymousCookie = (req: Request) => {
  if (process.env.NODE_ENV !== "production") {
    return false;
  }

  const forwardedHost = req.get("x-forwarded-host");
  if (forwardedHost) {
    return !isLoopbackHost(forwardedHost);
  }

  return !isLoopbackHost(req.get("host"));
};

const signRateLimitId = (secret: string, id: string) =>
  createHmac("sha256", secret).update(id).digest("base64url");

const issueAnonymousRateLimitCookie = (secret: string, id: string) => `${id}.${signRateLimitId(secret, id)}`;

const verifyAnonymousRateLimitCookie = (value: string | undefined, secret: string | undefined) => {
  if (!value || !secret) {
    return null;
  }

  const [id, providedSignature] = value.split(".");
  if (!id || !providedSignature) {
    return null;
  }

  const expectedSignature = signRateLimitId(secret, id);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  return id;
};

const publicSessionMatchesAgentSurface = (
  agent: PublicSessionAgent,
  token: string,
  sourceChannel: "anonymous" | "website_embed",
) => {
  if (sourceChannel === "website_embed") {
    return agent.surfaceSettings.websiteEmbed.enabled && (
      agent.surfaceSettings.websiteEmbed.token === token ||
      agent.surfaceSettings.anonymousChat.token === token
    );
  }

  return agent.surfaceSettings.anonymousChat.enabled && agent.surfaceSettings.anonymousChat.token === token;
};

const legacyWorkspaceAgent = (workspace: WorkspaceRecord | null): PublicSessionAgent | null => {
  if (!workspace) {
    return null;
  }

  return {
    id: workspace.defaultAgentId ?? workspace.id,
    workspaceId: workspace.id,
    name: workspace.assistantName,
    logo: null,
    theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
    proactiveGreetingEnabled: workspace.proactiveGreetingEnabled,
    surfaceSettings: {
      authenticatedChat: {
        enabled: true,
      },
      anonymousChat: {
        enabled: workspace.anonymousChatEnabled,
        token: workspace.anonymousChatToken,
      },
      websiteEmbed: {
        enabled: workspace.websiteEmbedEnabled,
        token: workspace.websiteEmbedToken,
        allowedOrigins: workspace.websiteEmbedAllowedOrigins,
        launcherLabel: workspace.websiteEmbedLauncherLabel,
        launcherPosition: workspace.websiteEmbedLauncherPosition,
        theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
        copy: {},
        expertOverrides: {},
      },
    },
  };
};

export const resolveAnonymousSession = (
  workspaceRepository: WorkspaceRepositoryPort,
  publicChatSessionSecret: string | undefined,
  anonymousRateLimitCookieSecret: string | undefined = publicChatSessionSecret,
  agentRepository?: Pick<AgentRepositoryPort, "findByAnonymousChatToken" | "findByWebsiteEmbedToken">,
  agentService?: Pick<AgentService, "resolve">,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedParams = anonymousTokenParamsSchema.safeParse(req.params);

      if (!parsedParams.success) {
        next(notFound("Not found"));
        return;
      }

      const { token } = parsedParams.data;
      const publicSession = verifyPublicChatSession(req.get(PUBLIC_CHAT_SESSION_HEADER), publicChatSessionSecret);
      const firstAgentByToken = async () => {
        if (!agentRepository) {
          return null;
        }

        if (publicSession?.sourceChannel === "website_embed") {
          return await agentRepository.findByWebsiteEmbedToken(token)
            ?? await agentRepository.findByAnonymousChatToken(token);
        }

        return await agentRepository.findByAnonymousChatToken(token)
          ?? await agentRepository.findByWebsiteEmbedToken(token);
      };
      const agentByToken = await firstAgentByToken();
      const workspace = publicSession
        ? await workspaceRepository.findById(publicSession.workspaceId)
        : agentByToken
          ? await workspaceRepository.findById(agentByToken.workspaceId)
          : await workspaceRepository.findByAnonymousChatToken(token)
            ?? await workspaceRepository.findByWebsiteEmbedToken(token);
      let agent: PublicSessionAgent | null = null;
      if (workspace && agentService && publicSession?.agentId) {
        try {
          agent = await agentService.resolve(workspace.id, publicSession?.agentId);
        } catch (error) {
          if (!(error instanceof AppError && error.statusCode === 404) || !publicSession?.agentId) {
            throw error;
          }
          agent = await agentService.resolve(workspace.id);
        }
      }
      agent = agent ?? agentByToken ?? (!agentService ? legacyWorkspaceAgent(workspace) : null);
      const hasValidPublicSession = Boolean(
        publicSession &&
        workspace &&
        agent &&
        publicSession.workspaceId === workspace.id &&
        agent.workspaceId === workspace.id &&
        publicSession.publicChatToken === token &&
        publicSessionMatchesAgentSurface(agent, token, publicSession.sourceChannel),
      );

      if (!workspace || !agent || !publicSession || !hasValidPublicSession) {
        next(notFound("Not found"));
        return;
      }

      const cookieName = `anon_session_${workspace.id}`;
      const rateLimitCookieName = `${ANONYMOUS_RATE_LIMIT_COOKIE_PREFIX}${workspace.id}`;
      const rateLimitIdFromCookie = verifyAnonymousRateLimitCookie(
        req.cookies?.[rateLimitCookieName] as string | undefined,
        anonymousRateLimitCookieSecret,
      );
      const rateLimitId = rateLimitIdFromCookie ?? randomUUID();
      const sessionId = publicSession.publicSessionId;

      res.cookie(cookieName, sessionId, {
        httpOnly: true,
        secure: shouldUseSecureAnonymousCookie(req),
        sameSite: "lax",
        maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
      });
      if (anonymousRateLimitCookieSecret) {
        res.cookie(rateLimitCookieName, issueAnonymousRateLimitCookie(anonymousRateLimitCookieSecret, rateLimitId), {
          httpOnly: true,
          secure: shouldUseSecureAnonymousCookie(req),
          sameSite: "lax",
          maxAge: COOKIE_MAX_AGE_SECONDS * 1000,
        });
      }
      res.setHeader(ANONYMOUS_SESSION_HEADER, sessionId);
      res.setHeader(PUBLIC_CHAT_SESSION_ID_HEADER, sessionId);

      res.locals.workspaceId = workspace.id;
      res.locals.agentId = agent.id;
      res.locals.workspaceName = resolveAssistantDisplayName({
        assistantName: agent.name,
        workspaceName: workspace.name,
      });
      res.locals.anonymousSessionId = sessionId;
      res.locals.anonymousRateLimitId = rateLimitId;
      res.locals.anonymousRateLimitIdFromCookie = Boolean(rateLimitIdFromCookie);
      res.locals.sourceChannel = publicSession?.sourceChannel ?? "anonymous";
      res.locals.sourceOrigin = publicSession?.sourceOrigin ?? null;
      res.locals.assistantBootstrapActive = isAgentBootstrapActive(agent);
      res.locals.assistantLogoAvailable = Boolean(agent.logo);
      res.locals.assistantTheme = agent.theme;
      next();
    } catch (error) {
      next(error);
    }
  };
};
