import { Router } from "express";

import { notFound } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";
import { createPreAuthSourceRateLimiter } from "../middleware/preAuthSourceRateLimiter.js";
import { replyImageParamsSchema } from "./replyImageAddress.js";

/**
 * Serves the stored copy of a reply block's image. Unauthenticated by design: the image id is an
 * unguessable capability, so the embed can load it cross-origin and a messaging provider can fetch
 * it. Showing an image is the same exposure as quoting its document, which the answer already did.
 * The response is private to the browser, so no shared cache outlives the image's deletion, and an
 * image that is gone is a plain 404. Each calling source has the budget of the other public reads,
 * spent before the lookup, so a guess at ids costs the guesser, not the database.
 */
export const createReplyImageRoutes = (
  dependencies: Pick<AppDependencies, "replyImageObjectLookup" | "documentStorage" | "abuseControlService" | "env">,
): Router => {
  const router = Router();

  const rateLimit = createPreAuthSourceRateLimiter({
    service: dependencies.abuseControlService,
    scope: "public.reply_image",
    // A carousel loads one copy per card, and a reloaded history its cards again: the public
    // session-read budget covers that many times over, and stops a loop.
    limit: dependencies.env.PUBLIC_CHAT_SESSION_READ_RATE_LIMIT_MAX_ATTEMPTS,
    windowMs: dependencies.env.PUBLIC_CHAT_RATE_LIMIT_WINDOW_MS,
  });

  router.get("/:imageId/:width", rateLimit, async (req, res, next) => {
    try {
      const params = replyImageParamsSchema.safeParse(req.params);
      const stored = params.success
        ? await dependencies.replyImageObjectLookup.findServable({
            imageId: params.data.imageId,
            width: Number(params.data.width),
          })
        : null;
      if (!stored) {
        next(notFound("Not found"));
        return;
      }
      const buffer = await dependencies.documentStorage.read({
        bucket: stored.bucket,
        objectPath: stored.objectPath,
        generation: stored.generation ?? null,
      });
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", 'inline; filename="image.webp"');
      res.setHeader("Cache-Control", "private, max-age=300");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.status(200).send(buffer);
    } catch (error) {
      next(error);
    }
  });

  return router;
};
