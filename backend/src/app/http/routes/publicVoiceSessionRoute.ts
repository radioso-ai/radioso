import type { RequestHandler, Response, Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import { AppError, notFound } from "../../../shared/domain/errors.js";
import { isLocaleTag } from "../../../shared/domain/locale.js";
import type { VoiceSessionStartResult } from "../../../modules/voiceChannel/public.js";
import { requirePublicChatPermission } from "../middleware/requirePermission.js";
import { publicVoiceSessionStartRateLimiters, type AnonymousRateLimiterDependencies } from "../middleware/anonymousRateLimiter.js";
import { validateBody } from "../middleware/validate.js";

export const publicVoiceSessionStartSchema = z.object({
  /** The caller's language as a language tag; the agent's default language applies without one. */
  locale: z.string().trim().refine(isLocaleTag, { message: "Must be a language tag such as en or it-IT" }).optional(),
}).strict();

type PublicVoiceSessionRouteDependencies = AnonymousRateLimiterDependencies
  & Pick<AppDependencies, "accountAccessService" | "voiceSessionStarts">;

const presentStartedSession = (result: Extract<VoiceSessionStartResult, { kind: "started" }>) => ({
  vendor: result.vendor,
  signedUrl: result.signedUrl,
  sessionKey: result.sessionKey,
  locale: result.locale,
  ...(result.expiresAt ? { expiresAt: result.expiresAt.toISOString() } : {}),
});

const failureOf = (result: Exclude<VoiceSessionStartResult, { kind: "started" }>): AppError => {
  switch (result.kind) {
    case "unavailable":
      return notFound("Voice sessions are not available for this agent.");
    case "credential_missing":
      return new AppError(409, "voice_vendor_credential_missing", "The workspace holds no API key for the agent's voice vendor.", { vendor: result.vendor });
    case "credential_unreadable":
      return new AppError(409, "voice_vendor_credential_unreadable", "The workspace's API key for the agent's voice vendor cannot be read.", { vendor: result.vendor });
    case "vendor_failed":
      return new AppError(502, "voice_vendor_unavailable", "The voice vendor did not start the session.", { vendor: result.vendor });
  }
};

/**
 * Mounts `POST /:token/voice/sessions` on the public chat router, behind the router's own public
 * session check: the same launch token, website embed origin and signed visitor session a chat
 * message needs. The vendor key stays on the backend; the page gets the vendor's signed URL and the
 * session key, which carries no Radioso access.
 */
export const registerPublicVoiceSessionRoute = (
  router: Router,
  dependencies: PublicVoiceSessionRouteDependencies & { publicSession: RequestHandler },
): void => {
  router.post(
    "/:token/voice/sessions",
    dependencies.publicSession,
    requirePublicChatPermission(dependencies, "public_chat.turn.create"),
    ...publicVoiceSessionStartRateLimiters(dependencies),
    validateBody(publicVoiceSessionStartSchema),
    async (req, res: Response, next) => {
      try {
        const { workspaceId, agentId } = res.locals as { workspaceId: string; agentId: string };
        const { locale } = req.body as z.infer<typeof publicVoiceSessionStartSchema>;
        const result = await dependencies.voiceSessionStarts.start({ workspaceId, agentId, ...(locale ? { locale } : {}) });
        if (result.kind !== "started") {
          next(failureOf(result));
          return;
        }
        // The signed URL opens a session on the workspace's vendor account: no cache may keep it.
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(presentStartedSession(result));
      } catch (error) {
        next(error);
      }
    },
  );
};
