import { z } from "zod";

import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";

/**
 * Identity of the extraction recipe. Facets produced by different versions are not
 * comparable, so every stored facet carries the version that produced it and a version
 * change invalidates facets rather than mixing generations in one clustering space.
 */
export const FACET_EXTRACTION_PROMPT_VERSION = "facet-extraction/1";

/** A facet is one phrase; the bound keeps a runaway generation out of the vector space. */
export const FACET_MAX_CHARACTERS = 160;

/**
 * Bounds the visitor text handed to extraction. Longer questions are truncated rather
 * than skipped, because a question that never yields a facet still has to count toward
 * the census window as unclassified.
 */
export const FACET_QUESTION_MAX_CHARACTERS = 2_000;

export const FACET_EXTRACTION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "facet_extraction",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["facet"],
    properties: {
      facet: { type: "string", minLength: 1, maxLength: FACET_MAX_CHARACTERS },
    },
  },
};

const HTML_SENSITIVE_CHARACTERS: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
};

const serializeUntrustedInput = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>&]/g, (character) => HTML_SENSITIVE_CHARACTERS[character]!);

/** Builds an explicit data envelope so visitor text cannot become instructions. */
export const buildFacetExtractionPrompt = (question: string): string => {
  const template = loadPromptTemplate("facet-extraction.md");
  const bounded = question.slice(0, FACET_QUESTION_MAX_CHARACTERS);
  return `${template}\n\n<facet-input>\n${serializeUntrustedInput(bounded)}\n</facet-input>`;
};

/** Total input + output budget passed to the generic inference pipeline. */
export const FACET_EXTRACTION_MAX_TOTAL_TOKENS = 4_000;
export const FACET_EXTRACTION_MAX_OUTPUT_TOKENS = 200;
export const FACET_EXTRACTION_MAX_INPUT_TOKENS =
  FACET_EXTRACTION_MAX_TOTAL_TOKENS - FACET_EXTRACTION_MAX_OUTPUT_TOKENS;

export class FacetExtractionValidationError extends Error {}

const facetExtractionOutputSchema = z.object({
  facet: z.string().trim().min(1).max(FACET_MAX_CHARACTERS),
});

export type FacetExtractionModelOutput = z.infer<typeof facetExtractionOutputSchema>;

/** Parses and validates a raw model completion against the strict facet schema. */
export const parseFacetExtractionModelOutput = (text: string): FacetExtractionModelOutput => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FacetExtractionValidationError("Facet extraction model response was not valid JSON");
  }
  try {
    return facetExtractionOutputSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new FacetExtractionValidationError("Facet extraction model response did not match the approved schema");
    }
    throw error;
  }
};
