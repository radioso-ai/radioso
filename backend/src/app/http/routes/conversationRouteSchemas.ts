import { z } from "zod";

export const conversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

export const historySearchParamsSchema = z.object({
  searchId: z.string().uuid(),
});

export const historyContactParamsSchema = z.object({
  requestId: z.string().uuid(),
});

export const collectionPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
  // Operator-test conversations (dashboard test chat, workbench replay) are excluded by
  // default; an operator can opt in via this scope. See shared/domain/conversationSource.
  sourceScope: z.enum(["end_user", "operator_test", "all"]).default("end_user"),
});

export const historyItemsPageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  sourceScope: z.enum(["end_user", "operator_test", "all"]).default("end_user"),
}).strict();

export const conversationWindowQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const conversationTailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
