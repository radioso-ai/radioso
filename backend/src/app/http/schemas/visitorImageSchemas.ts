import { z } from "zod";

import { VISITOR_IMAGE_LIMITS } from "../../../modules/visitorImages/public.js";

/**
 * The photos a message carries: ids an upload returned to the same caller, each at most once, in
 * the order the caller attached them.
 */
export const visitorImageIdsSchema = z.array(z.string().uuid())
  .min(1)
  .max(VISITOR_IMAGE_LIMITS.maxImagesPerMessage)
  .refine((ids) => new Set(ids).size === ids.length, "each image may be sent once")
  .describe(
    "Images uploaded for this message, in the order they were attached; at most three, each sent once. The agent reads each image at upload, and the message runs on its text followed by those readings.",
  );
