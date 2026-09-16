import { SLOT_REFERENCE_PATTERN } from "@radioso/routine-definition";
import { z } from "zod";

import { normalizeLocaleTag } from "./locale.js";

/**
 * Shared exact-content domain: the operator-authored greeting/routine-reply
 * shape (spec 1150 FR-003/FR-005/FR-007/FR-008/FR-009), its validation, and its
 * runtime resolution. Knows nothing of HTTP, Postgres, agents, routines, or
 * bootstrap — consumers supply the effective locale and the values already
 * available to them and interpret the outcome.
 */

const EXACT_CONTENT_MAX_CHIPS = 5;
export const EXACT_CONTENT_BODY_MAX_CODE_POINTS = 8000;
export const EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS = 80;

/** Counts Unicode code points, not UTF-16 units, so a single emoji counts once (FR-009). */
const codePointLength = (value: string): number => [...value].length;

const exactContentVariantSchema = z
  .object({
    locale: z.string().min(1),
    body: z.string(),
    chipLabels: z.record(z.string(), z.string()),
  })
  .strict();

export const exactContentItemSchema = z
  .object({
    chips: z
      .array(z.string().min(1))
      .max(EXACT_CONTENT_MAX_CHIPS)
      .refine((ids) => new Set(ids).size === ids.length, "chip ids must be unique"),
    variants: z.array(exactContentVariantSchema),
  })
  .strict();

type ExactContentVariant = z.infer<typeof exactContentVariantSchema>;
export type ExactContentItem = z.infer<typeof exactContentItemSchema>;

/**
 * Canonicalizes a locale tag for comparison: lowercase language, Titlecase
 * script, uppercase region. Reuses locale.ts's structure validation and
 * trimming; adds the casing step callers of that function don't need, so two
 * spellings of the same tag (e.g. "en-us" / "EN-US") are recognized as
 * duplicates and as the same delivery target.
 */
export const canonicalizeLocaleTag = (value: string): string | null => {
  let trimmed: string | null;
  try {
    trimmed = normalizeLocaleTag(value, "locale");
  } catch {
    return null;
  }
  if (!trimmed) {
    return null;
  }

  const [language, ...rest] = trimmed.split("-");
  const parts = [language.toLowerCase()];
  for (const part of rest) {
    if (part.length === 4) {
      parts.push(part[0].toUpperCase() + part.slice(1).toLowerCase());
    } else if (/^[0-9]{3}$/.test(part)) {
      parts.push(part);
    } else {
      parts.push(part.toUpperCase());
    }
  }
  return parts.join("-");
};

const baseLanguageOf = (tag: string): string => tag.split("-")[0] ?? tag;

/**
 * The routine engine's `{{slot.<key>}}` grammar, extended with the
 * `{{context.<key>}}` scope exact content also allows (FR-006). Built from
 * @radioso/routine-definition's SLOT_REFERENCE_PATTERN source (rather than a
 * hand-copied regex) so the two syntaxes cannot silently drift apart.
 */
const REFERENCE_PATTERN = new RegExp(
  SLOT_REFERENCE_PATTERN.source.replace("slot\\.", "(slot|context)\\."),
  SLOT_REFERENCE_PATTERN.flags,
);
const SINGLE_REFERENCE_PATTERN = new RegExp(`^${REFERENCE_PATTERN.source}$`, "u");
const ANY_BRACE_TOKEN_PATTERN = /\{\{([\s\S]*?)\}\}/gu;

/**
 * Distinct `{{…}}` tokens in `text` that are either malformed (not a
 * `slot.`/`context.` reference at all) or well-formed but absent from
 * `availableReferenceKeys`. Both are validation errors (edge case: a `{{…}}`
 * that doesn't match a known reference is rejected, never treated as literal
 * text).
 */
const findUnknownReferenceTokens = (
  text: string,
  availableReferenceKeys: ReadonlySet<string>,
): string[] => {
  const unknown = new Set<string>();
  for (const [raw] of text.matchAll(ANY_BRACE_TOKEN_PATTERN)) {
    if (!SINGLE_REFERENCE_PATTERN.test(raw)) {
      unknown.add(raw);
    }
  }
  for (const [raw, scope, key] of text.matchAll(REFERENCE_PATTERN)) {
    if (!availableReferenceKeys.has(`${scope}.${key}`)) {
      unknown.add(raw);
    }
  }
  return [...unknown];
};

type ExactContentValidationIssueCode =
  | "missing_default_variant"
  | "invalid_locale"
  | "duplicate_locale"
  | "blank_body"
  | "body_too_long"
  | "chip_label_missing"
  | "chip_label_unknown"
  | "chip_label_blank"
  | "chip_label_too_long"
  | "too_many_chips"
  | "duplicate_chip_id"
  | "unknown_reference";

export interface ExactContentValidationIssue {
  path: string;
  code: ExactContentValidationIssueCode;
  message: string;
}

export type ExactContentValidationResult =
  | { ok: true }
  | { ok: false; issues: ExactContentValidationIssue[] };

interface ValidateExactContentItemInput {
  agentDefaultLocale: string;
  availableReferenceKeys: ReadonlySet<string>;
}

/** Used identically by save, candidate validation, and preview (FR-007/FR-012). */
export const validateExactContentItem = (
  item: ExactContentItem,
  input: ValidateExactContentItemInput,
): ExactContentValidationResult => {
  const issues: ExactContentValidationIssue[] = [];
  const pushIssue = (path: string, code: ExactContentValidationIssueCode, message: string) =>
    issues.push({ path, code, message });
  const pushUnknownReferences = (text: string, path: string) => {
    for (const raw of findUnknownReferenceTokens(text, input.availableReferenceKeys)) {
      pushIssue(path, "unknown_reference", `Unknown reference ${raw}`);
    }
  };

  if (item.chips.length > EXACT_CONTENT_MAX_CHIPS) {
    pushIssue("chips", "too_many_chips", `At most ${EXACT_CONTENT_MAX_CHIPS} chips are allowed`);
  }
  if (new Set(item.chips).size !== item.chips.length) {
    pushIssue("chips", "duplicate_chip_id", "Chip ids must be unique");
  }
  const chipIds = new Set(item.chips);

  const localeOwnerByTag = new Map<string, number>();
  let hasDefaultVariant = false;
  const canonicalDefault = canonicalizeLocaleTag(input.agentDefaultLocale);
  if (canonicalDefault === null) {
    pushIssue("agentDefaultLocale", "invalid_locale", `"${input.agentDefaultLocale}" is not a valid locale tag`);
  }
  const normalizedDefault = canonicalDefault ?? input.agentDefaultLocale;

  item.variants.forEach((variant, index) => {
    const canonicalLocale = canonicalizeLocaleTag(variant.locale);
    const path = `variants[${index}]`;
    if (canonicalLocale === null) {
      pushIssue(`${path}.locale`, "invalid_locale", `"${variant.locale}" is not a valid locale tag`);
    }
    const normalizedLocale = canonicalLocale ?? variant.locale;

    const owner = localeOwnerByTag.get(normalizedLocale);
    if (owner === undefined) {
      localeOwnerByTag.set(normalizedLocale, index);
      hasDefaultVariant ||= normalizedLocale === normalizedDefault;
    } else {
      pushIssue(`${path}.locale`, "duplicate_locale", `Locale "${variant.locale}" duplicates variants[${owner}]`);
    }

    if (variant.body.trim().length === 0) {
      pushIssue(`${path}.body`, "blank_body", "Body must not be blank");
    } else if (codePointLength(variant.body) > EXACT_CONTENT_BODY_MAX_CODE_POINTS) {
      pushIssue(`${path}.body`, "body_too_long", `Body must be at most ${EXACT_CONTENT_BODY_MAX_CODE_POINTS} characters`);
    }
    pushUnknownReferences(variant.body, `${path}.body`);

    for (const chipId of chipIds) {
      const label = variant.chipLabels[chipId];
      const labelPath = `${path}.chipLabels.${chipId}`;
      if (label === undefined) {
        pushIssue(labelPath, "chip_label_missing", `Missing label for chip "${chipId}"`);
        continue;
      }
      if (label.trim().length === 0) {
        pushIssue(labelPath, "chip_label_blank", "Chip label must not be blank");
      } else if (codePointLength(label) > EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS) {
        pushIssue(
          labelPath,
          "chip_label_too_long",
          `Chip label must be at most ${EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS} characters`,
        );
      }
      pushUnknownReferences(label, labelPath);
    }
    for (const chipId of Object.keys(variant.chipLabels)) {
      if (!chipIds.has(chipId)) {
        pushIssue(`${path}.chipLabels.${chipId}`, "chip_label_unknown", `Chip "${chipId}" is not declared on this item`);
      }
    }
  });

  if (!hasDefaultVariant) {
    pushIssue(
      "variants",
      "missing_default_variant",
      `A variant for the agent default locale "${input.agentDefaultLocale}" is required`,
    );
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
};

const formatReferenceValue = (value: string | number | boolean | undefined): string | null => {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    // Missing/null/empty values are unavailable; zero and false are not (spec Edge Cases).
    return value.trim().length > 0 ? value : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value.toString() : null;
  }
  return value ? "true" : "false";
};

/**
 * Single pass over `text`: `String.replace` never rescans its own replacement
 * output, so a substituted value that itself contains `{{slot.x}}` stays
 * literal rather than being recursively resolved (spec Edge Cases).
 */
const substitute = (
  text: string,
  references: ReadonlyMap<string, string | number | boolean>,
): { text: string; ok: boolean } => {
  let ok = true;
  const substituted = text.replace(REFERENCE_PATTERN, (raw, scope: string, key: string) => {
    const formatted = formatReferenceValue(references.get(`${scope}.${key}`));
    if (formatted === null) {
      ok = false;
      return raw;
    }
    return formatted;
  });
  return { text: substituted, ok };
};

interface ResolveExactContentInput {
  requestedLocale: string | null;
  agentDefaultLocale: string;
  references: ReadonlyMap<string, string | number | boolean>;
}

export interface ExactContentChipResolution {
  id: string;
  label: string;
}

type ExactResolutionOutcome =
  | {
      kind: "resolved";
      locale: string;
      fallbackApplied: boolean;
      body: string;
      chips: ExactContentChipResolution[];
    }
  | { kind: "unavailable"; reason: "missing_variant" | "unavailable_reference" | "oversized" }
  | { kind: "conflict"; reason: string };

/**
 * Selects one variant — exact requested tag, then its bare base language,
 * then the agent default locale, never a different regional sibling (so a
 * request for pt-BR cannot fall back to an authored pt-PT variant) — and
 * substitutes its references in one pass (FR-005/FR-006). `fallbackApplied` is
 * true only when a locale was actually requested and the chosen variant isn't
 * that exact tag; a null request (no explicit/resolvable locale) is never a
 * fallback, even though it still resolves to the default variant.
 *
 * The whole item resolves or nothing does: one failing chip label fails the
 * item (FR-003). The `conflict` outcome is reserved for callers that must
 * report an ambiguous selection among multiple eligible exact candidates —
 * this resolver only ever selects within a single item and never produces it.
 */
export const resolveExactContent = (
  item: ExactContentItem,
  input: ResolveExactContentInput,
): ExactResolutionOutcome => {
  const normalizedDefault = canonicalizeLocaleTag(input.agentDefaultLocale) ?? input.agentDefaultLocale;
  const normalizedRequested = input.requestedLocale
    ? canonicalizeLocaleTag(input.requestedLocale) ?? input.requestedLocale
    : null;

  const variantByLocale = new Map<string, ExactContentVariant>();
  for (const variant of item.variants) {
    // A variant whose locale never canonicalizes (malformed data that predates locale
    // validation, or an author-supplied tag the format check missed) can never be an
    // addressable delivery target: it is excluded here rather than keyed by its raw string,
    // so it cannot coincidentally match a request or default that also failed to canonicalize.
    const tag = canonicalizeLocaleTag(variant.locale);
    if (tag !== null && !variantByLocale.has(tag)) {
      variantByLocale.set(tag, variant);
    }
  }

  let chosenLocale: string | undefined;
  if (normalizedRequested && variantByLocale.has(normalizedRequested)) {
    chosenLocale = normalizedRequested;
  } else if (normalizedRequested && variantByLocale.has(baseLanguageOf(normalizedRequested))) {
    chosenLocale = baseLanguageOf(normalizedRequested);
  } else if (variantByLocale.has(normalizedDefault)) {
    chosenLocale = normalizedDefault;
  }
  if (!chosenLocale) {
    return { kind: "unavailable", reason: "missing_variant" };
  }
  const variant = variantByLocale.get(chosenLocale)!;
  const fallbackApplied = normalizedRequested !== null && chosenLocale !== normalizedRequested;

  const bodyResult = substitute(variant.body, input.references);
  if (!bodyResult.ok) {
    return { kind: "unavailable", reason: "unavailable_reference" };
  }

  const chips: ExactContentChipResolution[] = [];
  for (const chipId of item.chips) {
    const rawLabel = variant.chipLabels[chipId];
    if (rawLabel === undefined) {
      return { kind: "unavailable", reason: "unavailable_reference" };
    }
    const labelResult = substitute(rawLabel, input.references);
    if (!labelResult.ok) {
      return { kind: "unavailable", reason: "unavailable_reference" };
    }
    chips.push({ id: chipId, label: labelResult.text });
  }

  if (codePointLength(bodyResult.text) > EXACT_CONTENT_BODY_MAX_CODE_POINTS) {
    return { kind: "unavailable", reason: "oversized" };
  }
  if (chips.some((chip) => codePointLength(chip.label) > EXACT_CONTENT_CHIP_LABEL_MAX_CODE_POINTS)) {
    return { kind: "unavailable", reason: "oversized" };
  }

  return { kind: "resolved", locale: chosenLocale, fallbackApplied, body: bodyResult.text, chips };
};
