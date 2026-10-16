import type { RequestHandler, Router } from "express";
import type { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import type { VoiceSessionStartResult } from "../../../modules/voiceChannel/public.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import {
  publicVoiceSessionStartRateLimiter,
  type PublicVoiceSessionRateLimiterDependencies,
} from "../middleware/publicVoiceSessionRateLimiter.js";
import { validateBody } from "../middleware/validate.js";
import { publicVoiceSessionStartSchema } from "./publicChatRouteSchemas.js";

type PublicVoiceSessionRouteDependencies = PublicVoiceSessionRateLimiterDependencies
  & Pick<AppDependencies, "accountAccessService" | "voiceSessionStarts">;

const UNAVAILABLE_MESSAGE = "Voice sessions are not available for this agent.";

const presentStartedSession = (result: Extract<VoiceSessionStartResult, { kind: "started" }>) => ({
  vendor: result.vendor,
  signedUrl: result.signedUrl,
  sessionKey: result.sessionKey,
  locale: result.locale,
  ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
});

/**
 * Only the website embed binds a public session to an origin the operator admitted, so only its
 * sessions may start a call on the workspace's vendor account. Another public channel reads as if
 * voice were off for the agent.
 */
const requireWebsiteEmbedSession: RequestHandler = (_req, res, next) => {
  next(res.locals.sourceChannel === "website_embed" ? undefined : notFound(UNAVAILABLE_MESSAGE));
};

/**
 * Mounts `POST /:token/voice/sessions` on the public chat router, behind the router's own public
 * session check: the same launch token, website embed origin and signed visitor session a chat
 * message needs. The vendor key stays on the backend; the page gets the vendor's signed URL and the
 * session key, a correlation handle that grants nothing. A visitor reads one failure for every
 * reason a start can fail; which one it was is in the metric and the warn log.
 */
export const registerPublicVoiceSessionRoute = (
  router: Router,
  dependencies: PublicVoiceSessionRouteDependencies & { publicSession: RequestHandler },
): void => {
  router.post(
    "/:token/voice/sessions",
    dependencies.publicSession,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    requireWebsiteEmbedSession,
    validateBody(publicVoiceSessionStartSchema),
    ...publicVoiceSessionStartRateLimiter(dependencies),
    async (req, res, next) => {
      try {
        const { workspaceId, agentId, chatSessionId, visitorKey } = res.locals as {
          workspaceId: string;
          agentId: string;
          chatSessionId: string;
          visitorKey: string | null;
        };
        const { locale } = req.body as z.infer<typeof publicVoiceSessionStartSchema>;
        const result = await dependencies.voiceSessionStarts.start({
          workspaceId,
          agentId,
          visitor: { publicSessionId: chatSessionId, visitorKey },
          ...(locale ? { locale } : {}),
        });
        if (result.kind === "unavailable") {
          next(notFound(UNAVAILABLE_MESSAGE));
          return;
        }
        if (result.kind === "failed") {
          next(new AppError(503, "voice_unavailable", "The voice session could not be started. Try again later."));
          return;
        }
        // The signed URL opens sessions on the workspace's vendor account until it expires: no cache may keep it.
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(presentStartedSession(result));
      } catch (error) {
        next(error);
      }
    },
  );
};
