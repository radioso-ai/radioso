import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";

import type { ApplicationRouteMount } from "../radiosoModuleTypes.js";
import type { EnterpriseHumanContactService } from "./humanContactService.js";

type RouteDependencies = Parameters<ApplicationRouteMount["createRouter"]>[0];

const WORKSPACE_HEADER = "x-workspace-id";
const PUBLIC_CHAT_SESSION_HEADER = "x-radioso-public-session";
const BEARER_PREFIX = "Bearer ";

const contactTriggerSourceSchema = z.enum([
  "manual",
  "assistant_suggestion",
  "no_context_refusal",
  "grounded_degraded_unsupported_segments",
  "explicit_user_request",
  "llm_classifier",
]);

const contactDraftSchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
});

const contactSubmitSchema = z.object({
  conversationId: z.string().uuid(),
  assistantMessageId: z.string().uuid().optional(),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(6000),
  triggerSource: contactTriggerSourceSchema,
  triggerReason: z.string().trim().max(500).optional(),
});

const contactSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  emailEnabled: z.boolean().optional(),
  defaultEmail: z.string().trim().email().max(320).nullable().optional(),
  webhookEnabled: z.boolean().optional(),
  webhookUrl: z.string().trim().url().max(2048).nullable().optional(),
  signingSecret: z.string().min(16).max(256).nullable().optional(),
  rotateSigningSecret: z.boolean().optional(),
});

const parseBody = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw {
    statusCode: 400,
    code: "bad_request",
    message: "Invalid request body",
    details: parsed.error.flatten(),
  };
};

const unauthorized = () => ({
  statusCode: 401,
  code: "unauthorized",
  message: "Unauthorized",
});

const notFound = (message = "Not found") => ({
  statusCode: 404,
  code: "not_found",
  message,
});

const requireWorkspaceSession = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const sessionToken = req.cookies?.[dependencies.env.SESSION_COOKIE_NAME];
    if (typeof sessionToken === "string" && sessionToken) {
      try {
        const session = await dependencies.authService.authenticateSession(sessionToken);
        await dependencies.accountAccessService.requireActiveMembership(session.accountId, session.userId);
        const resolved = await dependencies.workspaceSessionService.resolve({
          accountId: session.accountId,
          workspaceId: req.header(WORKSPACE_HEADER) ?? undefined,
        });
        res.locals.userId = session.userId;
        res.locals.accountId = resolved.accountId;
        res.locals.workspaceId = resolved.workspaceId;
        next();
        return;
      } catch {
        // Fall through to bearer auth.
      }
    }

    const authorization = req.header("authorization");
    const bearerToken = authorization?.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length).trim()
      : null;
    if (!bearerToken) {
      throw unauthorized();
    }

    const auth = await dependencies.authService.authenticateApiToken(bearerToken);
    res.locals.accountId = auth.accountId;
    res.locals.workspaceId = auth.workspaceId;
    next();
  } catch (error) {
    next(error);
  }
};

const signPayload = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

const verifyPublicChatSession = (token: string | undefined, secret: string | undefined) => {
  if (!token || !secret) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signPayload(secret, encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      workspaceId?: unknown;
      publicChatToken?: unknown;
      publicSessionId?: unknown;
      sourceChannel?: unknown;
      sourceOrigin?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.publicChatToken !== "string" ||
      typeof payload.publicSessionId !== "string" ||
      typeof payload.expiresAt !== "string" ||
      Date.parse(payload.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return {
      workspaceId: payload.workspaceId,
      publicChatToken: payload.publicChatToken,
      publicSessionId: payload.publicSessionId,
      sourceChannel: typeof payload.sourceChannel === "string" ? payload.sourceChannel : null,
      sourceOrigin: typeof payload.sourceOrigin === "string" ? payload.sourceOrigin : null,
    };
  } catch {
    return null;
  }
};

const requirePublicChatSession = (dependencies: RouteDependencies): RequestHandler => async (req, res, next) => {
  try {
    const token = String(req.params.token ?? "");
    const workspace = await dependencies.workspaceRepository.findByAnonymousChatToken(token);
    const publicSession = verifyPublicChatSession(
      req.header(PUBLIC_CHAT_SESSION_HEADER),
      dependencies.env.PUBLIC_CHAT_SESSION_SECRET,
    );
    if (!workspace || !publicSession || publicSession.workspaceId !== workspace.id || publicSession.publicChatToken !== token) {
      throw notFound();
    }

    res.locals.workspaceId = workspace.id;
    res.locals.anonymousSessionId = publicSession.publicSessionId;
    res.locals.sourceChannel = publicSession.sourceChannel ?? "anonymous";
    res.locals.sourceOrigin = publicSession.sourceOrigin;
    next();
  } catch (error) {
    next(error);
  }
};

export const createHumanContactRoutes = (
  dependencies: RouteDependencies,
  service: EnterpriseHumanContactService,
): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const publicChatSession = requirePublicChatSession(dependencies);

  router.get("/settings", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await service.getSettings({ workspaceId, accountId }));
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSettingsUpdateSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(200).json(await service.updateSettings({ workspaceId, accountId, ...body }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings/signing-secret", workspaceSession, async (_req, res, next) => {
    try {
      const { workspaceId } = res.locals as { workspaceId: string };
      res.status(200).json(await service.revealSigningSecret({ workspaceId }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/draft", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactDraftSchema, req.body);
      const { workspaceId, accountId, userId } = res.locals as {
        workspaceId: string;
        accountId: string;
        userId?: string;
      };
      const defaultEmail = userId ? (await dependencies.userRepository.findById(userId))?.email ?? null : null;
      const draft = await service.draft({
        workspaceId,
        accountId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        defaultEmail,
        sourceChannel: "authenticated_chat",
      });
      res.status(200).json({ ...draft, defaultEmail });
    } catch (error) {
      next(error);
    }
  });

  router.post("/submit", workspaceSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSubmitSchema, req.body);
      const { workspaceId, accountId } = res.locals as { workspaceId: string; accountId: string };
      res.status(202).json(await service.submit({
        workspaceId,
        accountId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        email: body.email,
        message: body.message,
        triggerSource: body.triggerSource,
        triggerReason: body.triggerReason,
        sourceChannel: "authenticated_chat",
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/public/chat/:token/draft", publicChatSession, async (req, res, next) => {
    try {
      const body = parseBody(contactDraftSchema, req.body);
      const { workspaceId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
        workspaceId: string;
        anonymousSessionId: string;
        sourceChannel: string | null;
        sourceOrigin: string | null;
      };
      res.status(200).json(await service.draft({
        workspaceId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        anonymousSessionId,
        sourceChannel,
        sourceOrigin,
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/public/chat/:token/submit", publicChatSession, async (req, res, next) => {
    try {
      const body = parseBody(contactSubmitSchema, req.body);
      const { workspaceId, anonymousSessionId, sourceChannel, sourceOrigin } = res.locals as {
        workspaceId: string;
        anonymousSessionId: string;
        sourceChannel: string | null;
        sourceOrigin: string | null;
      };
      res.status(202).json(await service.submit({
        workspaceId,
        conversationId: body.conversationId,
        assistantMessageId: body.assistantMessageId,
        anonymousSessionId,
        email: body.email,
        message: body.message,
        triggerSource: body.triggerSource,
        triggerReason: body.triggerReason,
        sourceChannel,
        sourceOrigin,
      }));
    } catch (error) {
      next(error);
    }
  });

  return router;
};
