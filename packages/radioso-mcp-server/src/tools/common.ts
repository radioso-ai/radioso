import { z } from "zod";

import type { JsonRecord, ToolDefinition } from "../types.js";

export const metadataRecordSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const retrievalPatchSchema = z.object({
  answerSupportPolicy: z.enum(["strict", "warn", "off"]).optional(),
  citationDisplayEnabled: z.boolean().optional(),
  conversationMode: z.enum(["factual", "guided", "exploratory"]).optional(),
  customInstruction: z.string().max(2000).optional(),
  lexicalRewriteInstructions: z.string().max(2000).optional(),
  metadataRules: z
    .array(
      z.object({
        effect: z.enum(["boost", "filter"]),
        enabled: z.boolean(),
        field: z.string().min(1),
        id: z.string().min(1),
        operator: z.enum(["equals", "not_equals", "contains", "not_contains", "lt", "lte", "gt", "gte"]),
        value: z.string(),
        valueType: z.enum(["string", "number", "date", "boolean"]),
      }),
    )
    .optional(),
  queryRewriteEnabled: z.boolean().optional(),
  rerankEnabled: z.boolean().optional(),
  rerankTopK: z.number().int().positive().optional(),
  semanticRewriteInstructions: z.string().max(2000).optional(),
  similarityThreshold: z.number().min(0).max(1).optional(),
  suggestedQuestionsCount: z.number().int().positive().optional(),
  suggestedQuestionsEnabled: z.boolean().optional(),
  vectorTopK: z.number().int().positive().optional(),
});

export type MetadataRecord = JsonRecord;
export type GenericToolDefinition<TArgs = Record<string, unknown>> = ToolDefinition<TArgs>;
