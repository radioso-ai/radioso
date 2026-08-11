import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

import { AppError, notFound } from "../../../shared/domain/errors.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AgentRepositoryPort } from "../../../db/repositories/agentRepository.js";
import type { AgentRecord, AgentService } from "../../../modules/agents/public.js";
import type { AccessGrant, AccessGrantService } from "../../../modules/accessGrants/public.js";
import { defaultAgentBrandingSettings, getWebsiteEmbedSurfaceSettings, isAgentBootstrapActive } from "../../../modules/agents/public.js";
import {
  resolveAssistantDisplayName,
} from "../../../modules/settings/contracts/assistantBootstrap.js";
import { defaultWebsiteEmbedSettings } from "../../../modules/settings/contracts/websiteEmbed.js";
import { isAllowedWebsiteEmbedOrigin, normalizeWebsiteEmbedOrigin } from "../../../shared/domain/websiteEmbed.js";
import {
  publicChatSessionMatchesLaunchToken,
  verifyPublicChatSession,
} from "../../../modules/settings/contracts/publicChatSession.js";

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const ANONYMOUS_SESSION_HEADER = "x-radioso-anonymous-session";
export const PUBLIC_CHAT_SESSION_HEADER = "x-radioso-public-session";
export const PUBLIC_CHAT_SESSION_ID_HEADER = "x-radioso-public-session-id";
const ANONYMOUS_RATE_LIMIT_COOKIE_PREFIX = "anon_rate_limit_";
const anonymousTokenParamsSchema = z.object({
  token: z.string().min(1),
});

type PublicSessionAgent = Pick<AgentRecord, "id" | "workspaceId" | "name" | "logo" | "theme" | "branding" | "assistantLinkUtmEnabled" | "citationDisplayEnabled" | "proactiveGreetingEnabled" | "surfaceSettings">;

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

const firstHeaderValue = (value: string | undefined) => value?.split(",")[0]?.trim() || undefined;

// The origin the request was actually served from (the API/widget host), as
// seen behind the reverse proxy. The embedded widget iframe is same-origin with
// the API, so the browser stamps this value into the Origin header of its
// non-GET requests — see publicSessionMatchesCurrentOrigin for why that must be
// treated as a same-origin request rather than a cross-origin replay.
export const resolveRequestAppOrigin = (req: Pick<Request, "get">): string | null => {
  const host = firstHeaderValue(req.get("x-forwarded-host")) ?? firstHeaderValue(req.get("host"));
  if (!host) {
    return null;
  }

  const protocol = firstHeaderValue(req.get("x-forwarded-proto")) ?? (isLoopbackHost(host) ? "http" : "https");
  return normalizeWebsiteEmbedOrigin(`${protocol}://${host}`);
};

// Derive a per-purpose HMAC key so the rate-limit cookie cannot be forged or
// substituted using any other HMAC produced from the same root secret (the
// secret is also used to issue public chat session tokens). The label is a
// stable domain-separation tag; bumping the version invalidates outstanding
// rate-limit cookies on rotation.
const RATE_LIMIT_COOKIE_KEY_LABEL = "radioso/anonymous-rate-limit-cookie/v1";

const deriveRateLimitCookieKey = (secret: string): Buffer =>
  createHmac("sha256", secret).update(RATE_LIMIT_COOKIE_KEY_LABEL).digest();

const signRateLimitId = (secret: string, id: string) =>
  createHmac("sha256", deriveRateLimitCookieKey(secret)).update(id).digest("base64url");

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
    const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
    return websiteEmbed.enabled && (
      websiteEmbed.token === token ||
      agent.surfaceSettings.anonymousChat.token === token
    );
  }

  return agent.surfaceSettings.anonymousChat.enabled && agent.surfaceSettings.anonymousChat.token === token;
};

const publicSessionMatchesCurrentOrigin = (
  agent: PublicSessionAgent,
  requestOriginHeader: string | undefined,
  sourceChannel: "anonymous" | "website_embed",
  sourceOrigin: string | null,
  appOrigin: string | null,
  originAllowed?: (origin: string) => boolean,
) => {
  if (sourceChannel !== "website_embed") {
    return true;
  }

  const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
  if (!websiteEmbed.enabled) {
    return false;
  }

  // Authorization rides on the session's bound origin, which is signed and was
  // validated against the allowlist at issuance. Re-checking it against the
  // current allowlist means removing an origin (or disabling embed) revokes
  // existing sessions. The bound origin — not the live request Origin — is the
  // source of truth, because the embedded widget iframe is served from the same
  // host as the API and browsers omit the Origin header on its same-origin
  // requests.
  const boundOrigin = sourceOrigin ? normalizeWebsiteEmbedOrigin(sourceOrigin) : null;
  if (!boundOrigin || !(originAllowed?.(boundOrigin) ?? (websiteEmbed.allowedOrigins.includes("*") || isAllowedWebsiteEmbedOrigin(websiteEmbed.allowedOrigins, boundOrigin)))) {
    return false;
  }

  // When a request carries an Origin from a genuinely cross-origin caller (e.g.
  // a static site streaming directly), it must match the session's bound origin
  // so a token issued for one origin cannot be replayed from another.
  //
  // The embedded widget iframe is same-origin with the API, and browsers attach
  // the Origin header to same-origin *non-GET* requests (POST message sends, the
  // proactive-greeting bootstrap, streaming) — set to the API's own origin, not
  // the embedding site. That value reveals nothing about where the widget is
  // hosted, so it is useless for replay detection: treat it like an omitted
  // Origin and authorize on the signed, allowlist-checked bound origin. Only an
  // Origin that is neither our own nor the bound origin is a real replay.
  const requestOrigin = requestOriginHeader ? normalizeWebsiteEmbedOrigin(requestOriginHeader) : null;
  if (requestOrigin && requestOrigin !== boundOrigin && requestOrigin !== appOrigin) {
    return false;
  }

  return true;
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
    // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
    theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
    branding: defaultAgentBrandingSettings(),
    assistantLinkUtmEnabled: true,
    citationDisplayEnabled: true,
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
        // Workspace rows predate agent-owned identity; use defaults until an agent record exists.
        theme: defaultWebsiteEmbedSettings().websiteEmbedTheme,
        copy: {},
        expertOverrides: {},
      },
      extensions: {},
    },
  };
};

export const resolveAnonymousSession = (
  workspaceRepository: Pick<WorkspaceRepositoryPort, "findById" | "findByAnonymousChatToken" | "findByWebsiteEmbedToken">,
  publicChatSessionSecret: string | undefined,
  anonymousRateLimitCookieSecret: string | undefined = publicChatSessionSecret,
  agentRepository?: Pick<AgentRepositoryPort, "findByAnonymousChatToken" | "findByWebsiteEmbedToken" | "findByIdAndWorkspaceId">,
  agentService?: Pick<AgentService, "resolve">,
  accessGrantService?: Pick<
    AccessGrantService,
    "resolvePublicLaunchGrant" | "evaluate" | "touchGrant" | "recordAuthFailure"
  >,
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
      const grantByToken = accessGrantService
        ? await accessGrantService.resolvePublicLaunchGrant(token)
        : null;
      const firstAgentByToken = async () => {
        if (!agentRepository) {
          return null;
        }

        if (grantByToken) {
          return agentRepository.findByIdAndWorkspaceId(grantByToken.agentId, grantByToken.workspaceId);
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
        : grantByToken
          ? await workspaceRepository.findById(grantByToken.workspaceId)
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
      const grantEvaluation = grantByToken
        ? accessGrantService?.evaluate(grantByToken, {
            origin: publicSession?.sourceChannel === "website_embed" ? publicSession.sourceOrigin : null,
          })
        : null;
      const grantAllowsOrigin = (grant: AccessGrant) => (origin: string) =>
        accessGrantService?.evaluate(grant, { origin }).allowed ?? false;
      const hasValidPublicSession = Boolean(
        publicSession &&
        workspace &&
        agent &&
        publicSession.workspaceId === workspace.id &&
        agent.workspaceId === workspace.id &&
        publicChatSessionMatchesLaunchToken(publicSession, publicChatSessionSecret, token) &&
        publicSessionMatchesAgentSurface(agent, token, publicSession.sourceChannel) &&
        (!grantByToken || (
          grantByToken.workspaceId === workspace.id &&
          grantByToken.agentId === agent.id &&
          grantEvaluation?.allowed
        )) &&
        publicSessionMatchesCurrentOrigin(
          agent,
          req.get("origin"),
          publicSession.sourceChannel,
          publicSession.sourceOrigin,
          resolveRequestAppOrigin(req),
          grantByToken && publicSession.sourceChannel === "website_embed" ? grantAllowsOrigin(grantByToken) : undefined,
        ),
      );

      if (!workspace || !agent || !publicSession || !hasValidPublicSession) {
        if (grantByToken && grantEvaluation && !grantEvaluation.allowed) {
          await accessGrantService?.recordAuthFailure({
            grant: grantByToken,
            reason: grantEvaluation.reason,
            surface: publicSession?.sourceChannel === "website_embed" ? "website-embed" : "anonymous-chat",
          });
        }
        next(notFound("Not found"));
        return;
      }

      if (grantByToken) {
        await accessGrantService?.touchGrant(grantByToken.id);
      }

      if (publicSession.sourceChannel === "website_embed") {
        const requestOrigin = normalizeWebsiteEmbedOrigin(req.get("origin") ?? "");
        if (requestOrigin) {
          res.vary("Origin");
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
        }
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
      res.locals.chatSessionId = sessionId;
      // Compatibility for existing middleware, API presenters, and feedback records.
      res.locals.anonymousSessionId = sessionId;
      res.locals.anonymousRateLimitId = rateLimitId;
      res.locals.anonymousRateLimitIdFromCookie = Boolean(rateLimitIdFromCookie);
      res.locals.sourceChannel = publicSession?.sourceChannel ?? "anonymous";
      res.locals.sourceOrigin = publicSession?.sourceOrigin ?? null;
      res.locals.authPrincipal = {
        type: "public_chat_session",
        role: "public",
        workspaceId: workspace.id,
        agentId: agent.id,
        publicSessionId: sessionId,
      };
      res.locals.assistantBootstrapActive = isAgentBootstrapActive(agent);
      res.locals.assistantLogoAvailable = Boolean(agent.logo);
      res.locals.assistantLogo = agent.logo;
      const websiteEmbed = getWebsiteEmbedSurfaceSettings(agent);
      res.locals.assistantTheme = websiteEmbed.theme;
      res.locals.assistantCopy = websiteEmbed.copy;
      res.locals.assistantBranding = agent.branding;
      res.locals.assistantLinkUtmEnabled = agent.assistantLinkUtmEnabled;
      res.locals.citationDisplayEnabled = agent.citationDisplayEnabled;
      next();
    } catch (error) {
      next(error);
    }
  };
};
