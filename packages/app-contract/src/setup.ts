import { z } from "zod";

import { assetIdSchema, digestSchema, displayNameSchema } from "./identifiers.js";

/**
 * What the operator reads and downloads while wiring an installation up. The
 * host renders these; an App never draws its own screens.
 */
const MEDIA_TYPE_PATTERN = /^[a-z]+\/[A-Za-z0-9.+_-]+$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const setupGuideSectionSchema = z.object({
  title: displayNameSchema,
  paragraphs: z.array(z.string().min(1).max(1000)).min(1).max(10),
  steps: z.array(z.string().min(1).max(600)).max(20).optional(),
}).strict();

export const setupGuideSchema = z.object({
  sections: z.array(setupGuideSectionSchema).min(1).max(10),
}).strict();

export const companionAssetSchema = z.object({
  id: assetIdSchema,
  label: displayNameSchema,
  fileName: z.string().regex(FILE_NAME_PATTERN),
  mediaType: z.string().regex(MEDIA_TYPE_PATTERN).max(128),
  digest: digestSchema,
}).strict();

export type SetupGuide = z.infer<typeof setupGuideSchema>;
export type CompanionAsset = z.infer<typeof companionAssetSchema>;
