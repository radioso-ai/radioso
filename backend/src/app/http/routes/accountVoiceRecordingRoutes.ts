import { Router } from "express";
import { z } from "zod";

import type { AppDependencies } from "../../server/types.js";
import type { VoiceRecordingLeftAtVendor } from "../../../modules/voiceChannel/public.js";
import { requireAccountPermission } from "../middleware/requirePermission.js";
import { requireSession, type SessionDependencies } from "../middleware/requireSession.js";
import { validateQuery } from "../middleware/validate.js";

export const voiceRecordingsLeftAtVendorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100)
    .describe("How many recordings to return, newest first. Defaults to 100; at most 500."),
  cursor: z.string().min(1).max(512).optional()
    .describe("The `nextCursor` of the page before, to read the next page."),
}).strict();

type AccountVoiceRecordingRouteDependencies = SessionDependencies & Pick<AppDependencies, "voiceRecordingsLeftAtVendor">;

const presentLeftAtVendor = (recording: VoiceRecordingLeftAtVendor) => ({
  vendor: recording.vendor,
  vendorRegion: recording.vendorRegion,
  vendorConversationId: recording.vendorConversationId,
  conversationId: recording.conversationId,
  workspaceId: recording.workspaceId,
  reason: recording.reason,
  failedAt: recording.failedAt.toISOString(),
});

/**
 * The organization's call recordings its deletions left at the voice vendor for good, so its owners
 * and admins can delete them there by the vendor's id. Organization-wide, deleted workspaces
 * included, so it takes the account session and the account role that may delete conversation
 * data (`workspace.history.delete`).
 */
export const createAccountVoiceRecordingRoutes = (dependencies: AccountVoiceRecordingRouteDependencies): Router => {
  const router = Router();
  const authenticatedSession = requireSession(dependencies);

  router.get(
    "/voice-recordings/left-at-vendor",
    authenticatedSession,
    requireAccountPermission(dependencies, "workspace.history.delete"),
    validateQuery(voiceRecordingsLeftAtVendorQuerySchema),
    async (req, res, next) => {
      try {
        const { accountId } = res.locals as { accountId: string };
        const { limit, cursor } = req.query as unknown as z.infer<typeof voiceRecordingsLeftAtVendorQuerySchema>;
        const listed = await dependencies.voiceRecordingsLeftAtVendor.listForAccount({ accountId, limit, ...(cursor ? { cursor } : {}) });
        res.set("Cache-Control", "no-store").status(200).json({
          total: listed.total,
          recordings: listed.recordings.map(presentLeftAtVendor),
          nextCursor: listed.nextCursor,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
};
