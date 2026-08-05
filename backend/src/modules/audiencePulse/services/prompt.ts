import type { JsonSchemaResponseFormat } from "../../../shared/infra/llm/providerTypes.js";
import { estimateTextGenerationInputTokens } from "../../../shared/infra/llm/modelInferencePipeline.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import {
  AUDIENCE_PULSE_MODEL_TEXT_LIMITS,
  type AudiencePulseGroundingSignal,
  type AudiencePulseWeeklyVolume,
} from "../domain/report.js";
import { AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS } from "../contracts/history.js";
import { serializeUntrustedInput } from "./untrustedJson.js";

/** Total input + output budget passed to the generic inference pipeline. */
export const AUDIENCE_PULSE_MAX_TOTAL_TOKENS = 10_000;
export const AUDIENCE_PULSE_MAX_OUTPUT_TOKENS = 2_000;
const AUDIENCE_PULSE_MAX_PROMPT_TOKENS = AUDIENCE_PULSE_MAX_TOTAL_TOKENS - AUDIENCE_PULSE_MAX_OUTPUT_TOKENS;

/**
 * At most this many of the census's richest topics get a recommendation slot and
 * illustrative exemplar evidence in this call (spec 956, `topicNamingPrompt.ts`
 * "Naming"): grouping is arithmetic now, so this call never partitions evidence --
 * it only writes prose and recommendations about topics the census already named and
 * sized. Smaller topics still appear in full, with exact counts, in the persisted
 * report; they are just summarized in aggregate (`additionalTopics`) for this call
 * rather than shown individually, the same bound the retired per-call theme cap held.
 */
export const AUDIENCE_PULSE_SUMMARY_MAX_TOPICS = 8;
export const AUDIENCE_PULSE_SUMMARY_MAX_EXEMPLARS_PER_TOPIC = 6;

/**
 * Response schema for the narrative call, sized to how many topics `topics` actually
 * shows the model this run. `themeIndex`'s range tracks `topicCount` exactly, so the
 * model has no in-schema way to reference a topic it was never shown -- unlike the
 * retired call's static `0..7`, which stayed valid even on a run with fewer themes.
 * `themes` remains a required key only because `audiencePulseModelOutputSchema`
 * (`domain/report.ts`) still declares it for the retired call's compatibility; every
 * call returns it empty; topic identity and membership come from the census, never
 * from the model.
 */
export const buildAudiencePulseResponseFormat = (topicCount: number): JsonSchemaResponseFormat => ({
  type: "json_schema",
  name: "audience_pulse_report",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "themes", "recommendations", "caveats"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: AUDIENCE_PULSE_MODEL_TEXT_LIMITS.summary },
      themes: {
        type: "array",
        maxItems: 0,
        items: { type: "object", additionalProperties: false, properties: {} },
      },
      recommendations: topicCount === 0
        ? {
          type: "array",
          maxItems: 0,
          items: { type: "object", additionalProperties: false, properties: {} },
        }
        : {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["themeIndex", "title", "rationale", "questions", "evidenceIds"],
            properties: {
              themeIndex: { type: "integer", minimum: 0, maximum: topicCount - 1 },
              title: { type: "string", minLength: 1, maxLength: AUDIENCE_PULSE_MODEL_TEXT_LIMITS.recommendationTitle },
              rationale: { type: "string", minLength: 1, maxLength: AUDIENCE_PULSE_MODEL_TEXT_LIMITS.recommendationRationale },
              questions: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: AUDIENCE_PULSE_MODEL_TEXT_LIMITS.question } },
              evidenceIds: { type: "array", minItems: 2, maxItems: 12, items: { type: "string", maxLength: 80 } },
            },
          },
        },
      caveats: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: AUDIENCE_PULSE_MODEL_TEXT_LIMITS.caveat } },
    },
  },
});

/** One exemplar question shown for a topic the census already formed and sized. */
export interface AudiencePulseSummaryTopicExemplar {
  id: string;
  conversationId: string;
  weekStart: string;
  channel: string | null;
  grounding: AudiencePulseGroundingSignal;
  contentGapEligible: boolean;
  question: string;
}

/**
 * One topic as this call sees it: already named, already sized exactly by the
 * census. `exemplars` illustrates the topic for the model; it is never the source of
 * `memberCount`/`share`, which are SQL-derived and passed through unchanged.
 */
export interface AudiencePulseSummaryTopic {
  title: string;
  description: string;
  memberCount: number;
  share: number;
  exemplars: AudiencePulseSummaryTopicExemplar[];
}

export interface AudiencePulseSummaryInput {
  period: { start: Date; end: Date };
  coverage: {
    populationSize: number;
    unclassifiedQuestionCount: number;
    /**
     * How many population questions topic analysis has actually run on
     * (`CensusRunResult.facetReadyQuestionCount`, spec 956 follow-up). Below
     * `populationSize`, part of this window is still being processed, and
     * `unclassifiedQuestionCount` includes that backlog, not only questions with no
     * recurring pattern -- see `audience-pulse.md` for how the model must read it.
     */
    facetReadyQuestionCount: number;
  };
  weeklyVolume: AudiencePulseWeeklyVolume[];
  /** Richest-first, already capped to `AUDIENCE_PULSE_SUMMARY_MAX_TOPICS` by the caller. */
  topics: AudiencePulseSummaryTopic[];
  /** The topics beyond `topics`, summarized so the model's prose can still be honest about total coverage. */
  additionalTopics: { count: number; share: number };
}

const toPromptInput = (input: AudiencePulseSummaryInput) => ({
  period: {
    start: input.period.start.toISOString(),
    end: input.period.end.toISOString(),
  },
  coverage: input.coverage,
  weeklyVolume: input.weeklyVolume,
  topics: input.topics.map((topic, index) => ({
    themeIndex: index,
    title: topic.title,
    description: topic.description,
    memberCount: topic.memberCount,
    share: topic.share,
    exemplars: topic.exemplars,
  })),
  additionalTopics: input.additionalTopics,
});

const promptFor = (input: AudiencePulseSummaryInput): string => {
  const template = loadPromptTemplate("audience-pulse.md");
  return `${template}\n\n<audience-pulse-input>\n${serializeUntrustedInput(toPromptInput(input))}\n</audience-pulse-input>`;
};

const withExemplarExcerptLimit = (input: AudiencePulseSummaryInput, limit: number): AudiencePulseSummaryInput => ({
  ...input,
  topics: input.topics.map((topic) => ({
    ...topic,
    exemplars: topic.exemplars.map((item) => ({
      ...item,
      question: item.question.slice(0, Math.min(limit, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS)),
    })),
  })),
});

/**
 * Preserves every topic and exemplar while shrinking each exemplar's transient
 * excerpt enough for the generic language-aware model guard, the same bisection the
 * retired raw-evidence prompt used (`AudiencePulseHistorySnapshot`'s old bound). This
 * call's input is inherently smaller -- at most `AUDIENCE_PULSE_SUMMARY_MAX_TOPICS *
 * AUDIENCE_PULSE_SUMMARY_MAX_EXEMPLARS_PER_TOPIC` exemplars versus the retired call's
 * much larger sample -- so it only ever needs to shrink, never drop, an exemplar.
 */
export const boundAudiencePulseSummaryInputForPrompt = (
  input: AudiencePulseSummaryInput,
): AudiencePulseSummaryInput => {
  const fits = (candidate: AudiencePulseSummaryInput): boolean =>
    estimateTextGenerationInputTokens({ prompt: promptFor(candidate) }) <= AUDIENCE_PULSE_MAX_PROMPT_TOKENS;

  const capped = withExemplarExcerptLimit(input, AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS);
  if (fits(capped)) return capped;

  let lower = 0;
  let upper = AUDIENCE_PULSE_EVIDENCE_EXCERPT_MAX_CHARACTERS;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(withExemplarExcerptLimit(input, middle))) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return withExemplarExcerptLimit(input, lower);
};

/** Builds an explicit data envelope so untrusted evidence text cannot become instructions. */
export const buildAudiencePulsePrompt = (input: AudiencePulseSummaryInput): string => promptFor(input);
