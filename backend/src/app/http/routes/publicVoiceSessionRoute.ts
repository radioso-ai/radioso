import type { RequestHandler, Router } from "express";
import type { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, badRequest, notFound } from "../../../shared/domain/errors.js";
import type { VoiceSessionStartResult, VoiceVendorConversationReportPort } from "../../../modules/voiceChannel/public.js";

import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import {
  publicVoiceSessionStartRateLimiter,
  type PublicVoiceSessionRateLimiterDependencies,
} from "../middleware/publicVoiceSessionRateLimiter.js";
import { validateBody } from "../middleware/validate.js";
import {
  publicVoiceSessionParamsSchema,
  publicVoiceSessionStartSchema,
  publicVoiceVendorConversationSchema,
} from "./publicChatRouteSchemas.js";

type PublicVoiceSessionRouteDependencies = PublicVoiceSessionRateLimiterDependencies
  & Pick<AppDependencies, "accountAccessService" | "voiceSessionStarts">
  & { voiceRecordings: VoiceVendorConversationReportPort };

const UNAVAILABLE_MESSAGE = "Voice sessions are not available for this agent.";

const presentStartedSession = (result: Extract<VoiceSessionStartResult, { kind: "started" }>) => ({
  vendor: result.vendor,
  signedUrl: result.signedUrl,
  sessionKey: result.sessionKey,
  locale: result.locale,
  ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
  ...(result.recordingNotice ? { recordingNotice: result.recordingNotice } : {}),
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
 * Mounts `POST /:token/voice/sessions` and `POST /:token/voice/sessions/:sessionKey/vendor-conversation`
 * on the public chat router, behind the router's own public session check: the same launch token,
 * website embed origin and signed visitor session a chat message needs. The vendor key stays on the
 * backend; the page gets the vendor's signed URL and the session key, a correlation handle that
 * grants nothing, and later reports the vendor's id for the call it opened. A visitor reads one
 * failure for every reason a start can fail; which one it was is in the metric and the warn log.
 */

export const registerPublicVoiceSessionRoute = (
  router: Router,
  dependencies: PublicVoiceSessionRouteDependencies & {
    publicSession: RequestHandler;
    /** The public session's own request budget, which the vendor conversation report spends. */
    sessionRequestRateLimit: RequestHandler;
  },
): void => {
  // The page reports the vendor's id for the call it opened, once, for a session Radioso started
  // for this same public session. The id only ever names a recording looked up with the
  // workspace's own vendor key; anything else about the request reads as no such session.
  router.post(
    "/:token/voice/sessions/:sessionKey/vendor-conversation",
    dependencies.publicSession,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    requireWebsiteEmbedSession,
    validateBody(publicVoiceVendorConversationSchema),
    dependencies.sessionRequestRateLimit,
    async (req, res, next) => {
      try {
        const params = publicVoiceSessionParamsSchema.safeParse(req.params);
        if (!params.success) {
          next(badRequest("Invalid request params", params.error.flatten()));
          return;
        }
        const { workspaceId, agentId, chatSessionId } = res.locals as { workspaceId: string; agentId: string; chatSessionId: string };
        const { sessionKey } = params.data;

        const { vendorConversationId } = req.body as z.infer<typeof publicVoiceVendorConversationSchema>;
        const outcome = await dependencies.voiceRecordings.report({
          workspaceId,
          agentId,
          sessionKey,
          publicSessionId: chatSessionId,
          vendorConversationId,
        });
        if (outcome === "rejected") {
          next(notFound("No voice session waits for this report."));
          return;
        }
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );


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
