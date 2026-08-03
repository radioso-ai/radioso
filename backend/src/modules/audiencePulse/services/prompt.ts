import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { estimateTextGenerationInputTokens } from "../../../shared/infra/llm/modelInferencePipeline.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import {
  AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS,
  type AudiencePulseHistorySnapshot,
} from "../contracts.js";

/** Total input + output budget passed to the generic inference pipeline. */
export const AUDIENCE_PULSE_MAX_TOTAL_TOKENS = 10_000;
export const AUDIENCE_PULSE_MAX_OUTPUT_TOKENS = 2_000;
const AUDIENCE_PULSE_MAX_PROMPT_TOKENS = AUDIENCE_PULSE_MAX_TOTAL_TOKENS - AUDIENCE_PULSE_MAX_OUTPUT_TOKENS;

export const AUDIENCE_PULSE_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  name: "audience_pulse_report",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "themes", "recommendations", "caveats"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: 600 },
      themes: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "evidenceIds"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            description: { type: "string", minLength: 1, maxLength: 500 },
            evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 80 } },
          },
        },
      },
      recommendations: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["themeIndex", "title", "rationale", "questions", "evidenceIds"],
          properties: {
            themeIndex: { type: "integer", minimum: 0, maximum: 7 },
            title: { type: "string", minLength: 1, maxLength: 160 },
            rationale: { type: "string", minLength: 1, maxLength: 500 },
            questions: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 240 } },
            evidenceIds: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 80 } },
          },
        },
      },
      caveats: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 320 } },
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

const toPromptInput = (snapshot: AudiencePulseHistorySnapshot) => ({
  period: {
    start: snapshot.period.start.toISOString(),
    end: snapshot.period.end.toISOString(),
  },
  coverage: snapshot.coverage,
  weeklyVolume: snapshot.weeklyVolume,
  evidence: snapshot.evidence.map((item) => ({
    id: item.id,
    weekStart: item.weekStart,
    grounding: item.grounding,
    contentGapEligible: item.contentGapEligible,
    question: item.question,
  })),
});

const promptFor = (snapshot: AudiencePulseHistorySnapshot): string => {
  const template = loadPromptTemplate("audience-pulse.md");
  return `${template}\n\n<audience-pulse-input>\n${serializeUntrustedInput(toPromptInput(snapshot))}\n</audience-pulse-input>`;
};

const withExcerptLimit = (snapshot: AudiencePulseHistorySnapshot, limit: number): AudiencePulseHistorySnapshot => ({
  ...snapshot,
  evidence: snapshot.evidence.map((item) => ({
    ...item,
    question: item.question.slice(0, Math.min(limit, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS)),
  })),
});

/**
 * Preserves the deterministic evidence set while shrinking every transient excerpt
 * enough for the generic language-aware model guard. The model never sees an input
 * that can exceed its declared cost bound, including multilingual text or JSON escapes.
 */
export const boundAudiencePulseHistoryForPrompt = (
  snapshot: AudiencePulseHistorySnapshot,
): AudiencePulseHistorySnapshot => {
  const fits = (candidate: AudiencePulseHistorySnapshot): boolean =>
    estimateTextGenerationInputTokens({ prompt: promptFor(candidate) }) <= AUDIENCE_PULSE_MAX_PROMPT_TOKENS;

  const capped = withExcerptLimit(snapshot, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS);
  if (fits(capped)) return capped;

  let lower = 0;
  let upper = AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(withExcerptLimit(snapshot, middle))) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return withExcerptLimit(snapshot, lower);
};

/** Builds an explicit data envelope so conversation text cannot become instructions. */
export const buildAudiencePulsePrompt = (snapshot: AudiencePulseHistorySnapshot): string => promptFor(snapshot);
