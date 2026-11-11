import { Router } from "express";
import { z } from "zod";

import { DOCUMENT_IMAGE_RENDITION_WIDTHS } from "../../../modules/documents/contracts/index.js";
import { notFound } from "../../../shared/domain/errors.js";
import type { AppDependencies } from "../../server/types.js";

/** Where the image route is mounted; a stored image is served at `/{imageId}/{width}` below it. */
export const REPLY_IMAGE_ROUTE_PATH = "/api/v1/public/reply-images";

const replyImageParamsSchema = z.object({
  imageId: z.string().uuid(),
  width: z.coerce.number().int().refine(
    (width) => (DOCUMENT_IMAGE_RENDITION_WIDTHS as readonly number[]).includes(width),
  ),
});

/**
 * Serves the stored copy of a reply block's image. Unauthenticated by design: the image id is an
 * unguessable capability, so the embed can load it cross-origin and a messaging provider can fetch
 * it. Showing an image is the same exposure as quoting its document, which the answer already did.
 * The response is private to the browser, so no shared cache outlives the image's deletion, and an
 * image that is gone is a plain 404.
 */
export const createReplyImageRoutes = (dependencies: AppDependencies): Router => {
  const router = Router();

  router.get("/:imageId/:width", async (req, res, next) => {
    try {
      const params = replyImageParamsSchema.safeParse(req.params);
      const stored = params.success
        ? await dependencies.replyImageObjectLookup.findServable(params.data)
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
