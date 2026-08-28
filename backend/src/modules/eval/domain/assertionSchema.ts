import { z } from "zod";

import type { EvalAssertion } from "./types.js";

const answerMatchModeSchema = z.enum(["substring", "regex"]);

const answerAssertionFields = {
  pattern: z.string().min(1).max(4000),
  matchMode: answerMatchModeSchema,
  caseSensitive: z.boolean().optional(),
};

/**
 * The wire contract for every stored Eval assertion. Eval routes and OpenAPI
 * both consume this schema so a new assertion variant cannot reach one surface
 * without being represented on the other.
 */
export const evalAssertionSchema: z.ZodType<EvalAssertion> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("retrieval_includes_document"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("retrieval_excludes_document"),
    documentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("retrieval_top_k_includes_document"),
    documentId: z.string().uuid(),
    k: z.number().int().min(1).max(100),
  }),
  z.object({
    type: z.literal("retrieval_document_order"),
    documentIds: z.array(z.string().uuid()).min(1).max(100),
  }),
  z.object({
    type: z.literal("retrieval_chunk_metadata"),
    documentId: z.string().uuid(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).refine(
      (metadata) => Object.keys(metadata).length > 0,
      "metadata must include at least one expected field",
    ),
  }),
  z.object({
    type: z.literal("answer_cites_document"),
    documentId: z.string().uuid(),
  }),
  z.object({ type: z.literal("answer_contains"), ...answerAssertionFields }),
  z.object({ type: z.literal("answer_does_not_contain"), ...answerAssertionFields }),
  z.object({
    type: z.literal("llm_judge"),
    expectedAnswer: z.string().min(1).max(8000),
    criteria: z.string().max(2000).optional(),
  }),
]);
