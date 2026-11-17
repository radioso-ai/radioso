import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { readDocumentAttributes, renderDocumentAttributes } from "../domain/documentAttributes.js";

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
// Prompt lines also fold control characters, so metadata cannot open a line of its own.
const toPromptLineText = (value: string): string => value.replace(/[\s\p{Cc}]+/gu, " ").trim();

const METADATA_SEPARATOR = " | ";
const PROMPT_ATTRIBUTE_PREFIX = "Attributes: ";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_LABEL_FORMATTERS = [
  new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }),
  new Intl.DateTimeFormat("it", { month: "long", year: "numeric", timeZone: "UTC" }),
];

export const renderSearchText = (input: {
  title: string;
  subjectLabel?: string | null;
  sectionPath?: string | null;
  attributeText?: string | null;
  content: string;
}): string => {
  const parts = [
    input.title ? `Title: ${normalizeWhitespace(input.title)}` : "",
    input.subjectLabel ? `Subject: ${normalizeWhitespace(input.subjectLabel)}` : "",
    input.sectionPath ? `Section: ${normalizeWhitespace(input.sectionPath)}` : "",
    // The chunk's own text comes before its attributes: a reader of the first characters
    // (the reranker) sees what sets this chunk apart, and an input cut short loses
    // attributes rather than text.
    normalizeWhitespace(input.content),
    input.attributeText ? `Attributes: ${normalizeWhitespace(input.attributeText)}` : "",
  ].filter((part) => part.length > 0);

  return parts.join("\n\n");
};

export const buildRetrievalText = (input: {
  title: string;
  content: string;
}): string => renderSearchText(input);

const renderMetadataParts = (
  metadata: Record<string, unknown>,
  options: { includeUrl: boolean; includeMonthAliases: boolean },
): string[] => {
  const dateFrom = normalizeIsoDay(metadata.dateFrom);
  const dateTo = normalizeIsoDay(metadata.dateTo);
  const url = pickMetadataUrl(metadata);
  const author = typeof metadata.author === "string" ? normalizeWhitespace(metadata.author) : "";
  const monthKeys = options.includeMonthAliases ? collectMonthKeys(dateFrom, dateTo) : [];
  const monthLabels = monthKeys.flatMap((monthKey) => renderMonthLabels(monthKey));

  const parts = [
    dateFrom ? `Date from: ${dateFrom}` : "",
    dateTo ? `Date to: ${dateTo}` : "",
    ...(options.includeMonthAliases
      ? [
          ...monthKeys.map((monthKey) => `Month key: ${monthKey}`),
          ...monthLabels.map((label) => `Month label: ${label}`),
        ]
      : []),
    options.includeUrl && url ? `URL: ${url}` : "",
    author ? `Author: ${author}` : "",
  ].filter((part) => part.length > 0);

  return parts;
};

/**
 * The metadata a chunk's embedded search text carries. The facts its document states
 * about itself follow, within `documentAttributeChars`, so they never outweigh a
 * short chunk's own text.
 */
export const renderMetadataSearchText = (
  metadata: Record<string, unknown>,
  options: { documentAttributeChars?: number } = {},
): string => {
  const parts = renderMetadataParts(metadata, { includeUrl: true, includeMonthAliases: true });
  const attributeChars = options.documentAttributeChars ?? Number.POSITIVE_INFINITY;
  return [...parts, ...renderDocumentAttributes(readDocumentAttributes(metadata), attributeChars)].join(METADATA_SEPARATOR);
};

/**
 * The `Attributes:` line a retrieved chunk carries into the answer prompt, or "" when it
 * has none: dates and author, then the document's own attributes as quoted data, at most
 * `promptContextMaxAttributeChars` characters in all. Context selection charges this line
 * against the passage's budget, so both read it from here.
 */
export const renderPromptAttributeLine = (metadata: Record<string, unknown> | undefined): string => {
  const maxChars = RETRIEVAL_BEHAVIOR.promptContextMaxAttributeChars;
  const parts = renderMetadataParts(metadata ?? {}, { includeUrl: false, includeMonthAliases: false }).map(toPromptLineText);
  const usedChars = PROMPT_ATTRIBUTE_PREFIX.length + parts.join(METADATA_SEPARATOR).length;
  const attributeChars = maxChars - usedChars - (parts.length > 0 ? METADATA_SEPARATOR.length : 0);
  const entries = renderDocumentAttributes(readDocumentAttributes(metadata), Math.max(0, attributeChars));
  const all = [...parts, ...entries];
  return all.length > 0 ? `${PROMPT_ATTRIBUTE_PREFIX}${all.join(METADATA_SEPARATOR)}`.slice(0, maxChars) : "";
};

const pickMetadataUrl = (metadata: Record<string, unknown>): string => {
  const sourceUrl = typeof metadata.sourceUrl === "string" ? normalizeWhitespace(metadata.sourceUrl) : "";
  if (sourceUrl) {
    return sourceUrl;
  }
  return typeof metadata.url === "string" ? normalizeWhitespace(metadata.url) : "";
};

const normalizeIsoDay = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return ISO_DAY_PATTERN.test(normalized) ? normalized : null;
};

const collectMonthKeys = (dateFrom: string | null, dateTo: string | null): string[] => {
  const start = dateFrom ?? dateTo;
  const end = dateTo ?? dateFrom;
  if (!start || !end) {
    return [];
  }

  const startParts = parseIsoDay(start);
  const endParts = parseIsoDay(end);
  if (!startParts || !endParts) {
    return [];
  }

  const keys: string[] = [];
  let year = startParts.year;
  let month = startParts.month;
  while (year < endParts.year || (year === endParts.year && month <= endParts.month)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
};

const parseIsoDay = (value: string): { year: number; month: number } | null => {
  if (!ISO_DAY_PATTERN.test(value)) {
    return null;
  }

  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }

  return { year, month };
};

const renderMonthLabels = (monthKey: string): string[] => {
  const [yearText, monthText] = monthKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return [];
  }

  const date = new Date(Date.UTC(year, month - 1, 1));
  return [...new Set(MONTH_LABEL_FORMATTERS.map((formatter) => normalizeWhitespace(formatter.format(date))))];
};
