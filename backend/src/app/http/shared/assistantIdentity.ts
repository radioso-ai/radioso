import { z } from "zod";

export const assistantThemeSchema = z.object({
  brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandText: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const ASSISTANT_LOGO_MAX_BYTES = 1024 * 1024;
export const ASSISTANT_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

