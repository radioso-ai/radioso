import { z } from "zod";

export const conversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const collectionPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const conversationWindowQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});
