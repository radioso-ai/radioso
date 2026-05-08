const DEFAULT_MAX_CLASSIFIER_LABEL_LENGTH = 80;
const DEFAULT_MAX_CLASSIFIER_LABEL_TERMS = 8;
const MAX_LANGUAGE_LABEL_LENGTH = 40;
const MAX_LANGUAGE_LABEL_TERMS = 3;

const GENERAL_LABEL_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} '&/().,:°-]*$/u;
const LANGUAGE_LABEL_PATTERN = /^[\p{L}\p{M}]+(?:[ -][\p{L}\p{M}]+)*$/u;
const UNSAFE_CLASSIFIER_FIELD_PATTERN =
  /\b(?:answer|bypass|developer|ignore|instead|instructions?|jailbreak|links?|must|override|previous|prompt|provide|raw|respond|reveal|should|sources?|system|translate|use)\b/i;
const VAGUE_CLASSIFIER_FIELD_PATTERN =
  /^(?:same\s+(?:as|language)|current\s+user\s+question|none|null|n\/a|unknown|uncertain)$/i;

export interface LlmClassifierLabelOptions {
  maxLength?: number;
  maxTerms?: number;
  allowLanguageLabelOnly?: boolean;
  rejectVague?: boolean;
}

const hasUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return Boolean(url.protocol);
  } catch {
    return /https?:\/\/|www\./i.test(value);
  }
};

export const normalizeLlmClassifierLabel = (
  value: unknown,
  options: LlmClassifierLabelOptions = {},
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[`#*_~[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const maxLength = options.maxLength ?? DEFAULT_MAX_CLASSIFIER_LABEL_LENGTH;
  const maxTerms = options.maxTerms ?? DEFAULT_MAX_CLASSIFIER_LABEL_TERMS;
  const labelPattern = options.allowLanguageLabelOnly ? LANGUAGE_LABEL_PATTERN : GENERAL_LABEL_PATTERN;

  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    hasUrl(normalized) ||
    UNSAFE_CLASSIFIER_FIELD_PATTERN.test(normalized) ||
    (options.rejectVague !== false && VAGUE_CLASSIFIER_FIELD_PATTERN.test(normalized)) ||
    !labelPattern.test(normalized)
  ) {
    return undefined;
  }

  const termCount = normalized.split(/[\s/-]+/).filter(Boolean).length;
  return termCount > maxTerms ? undefined : normalized;
};

export const normalizeLlmClassifierLanguageLabel = (value: unknown): string | undefined =>
  normalizeLlmClassifierLabel(value, {
    allowLanguageLabelOnly: true,
    maxLength: MAX_LANGUAGE_LABEL_LENGTH,
    maxTerms: MAX_LANGUAGE_LABEL_TERMS,
  });
