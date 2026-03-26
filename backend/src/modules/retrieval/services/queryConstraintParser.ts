import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import {
  normalizeDateConstraint,
  normalizeLocationConstraint,
  normalizeMoneyConstraint,
} from "./attributeNormalizer.js";

const DATE_AFTER_PATTERN = /\b(?:after|from)\s+(\d{4}-\d{2}-\d{2})\b/i;
const DATE_BEFORE_PATTERN = /\bbefore\s+(\d{4}-\d{2}-\d{2})\b/i;
const DATE_ON_PATTERN = /\bon\s+(\d{4}-\d{2}-\d{2})\b/i;
const MONEY_LTE_PATTERN = /\b(?:under|below|less than)\s+(\d+(?:\.\d{1,2})?)\s*(EUR|USD)?\b/i;
const MONEY_GTE_PATTERN = /\b(?:over|above|more than)\s+(\d+(?:\.\d{1,2})?)\s*(EUR|USD)?\b/i;
const LOCATION_PATTERN =
  /\bin\s+([a-z][a-z]+(?:\s+[a-z][a-z]+)*?)(?=\s+(?:under|below|less than|over|above|more than|after|before|on|with|about|for|near|around|regarding)\b|[?.!,]|$)/i;
const LEADING_RETRIEVAL_VERB_PATTERN = /^(?:find|show|list|search for|search)\s+/i;

const normalizeSearchQuery = (query: string): string =>
  query
    .replace(LEADING_RETRIEVAL_VERB_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

export const parseQueryConstraints = (query: string): ParsedQueryInterpretation => {
  const constraints: ParsedQueryInterpretation["constraints"] = [];
  const semanticQuery = normalizeSearchQuery(query);
  const lexicalQuery = normalizeSearchQuery(query);

  const locationMatch = query.match(LOCATION_PATTERN);
  const location = locationMatch?.[1];
  if (location && locationMatch?.[0]) {
    const normalized = normalizeLocationConstraint(location);
    if (normalized) {
      constraints.push({
        signalKey: "document_location",
        operator: "match",
        confidence: 0.95,
        summary: `in ${normalized.displayName}`,
        sourceText: locationMatch[0].trim(),
        value: normalized,
      });
    }
  }

  const moneyLte = query.match(MONEY_LTE_PATTERN);
  if (moneyLte?.[1]) {
    const normalized = normalizeMoneyConstraint(moneyLte[1], moneyLte[2] ?? null);
    if (normalized) {
      constraints.push({
        signalKey: "document_amount",
        operator: "lte",
        confidence: 0.95,
        summary: `under ${normalized.amount}${normalized.currencyCode ? ` ${normalized.currencyCode}` : ""}`,
        sourceText: moneyLte[0].trim(),
        value: normalized,
      });
    }
  }

  const moneyGte = query.match(MONEY_GTE_PATTERN);
  if (moneyGte?.[1]) {
    const normalized = normalizeMoneyConstraint(moneyGte[1], moneyGte[2] ?? null);
    if (normalized) {
      constraints.push({
        signalKey: "document_amount",
        operator: "gte",
        confidence: 0.95,
        summary: `over ${normalized.amount}${normalized.currencyCode ? ` ${normalized.currencyCode}` : ""}`,
        sourceText: moneyGte[0].trim(),
        value: normalized,
      });
    }
  }

  const dateAfterMatch = query.match(DATE_AFTER_PATTERN);
  const dateAfter = dateAfterMatch?.[1];
  if (dateAfter && dateAfterMatch?.[0]) {
    const normalized = normalizeDateConstraint(dateAfter);
    if (normalized) {
      constraints.push({
        signalKey: "document_period",
        operator: "gte",
        confidence: 0.95,
        summary: `after ${normalized}`,
        sourceText: dateAfterMatch[0].trim(),
        value: { date: normalized },
      });
    }
  }

  const dateBeforeMatch = query.match(DATE_BEFORE_PATTERN);
  const dateBefore = dateBeforeMatch?.[1];
  if (dateBefore && dateBeforeMatch?.[0]) {
    const normalized = normalizeDateConstraint(dateBefore);
    if (normalized) {
      constraints.push({
        signalKey: "document_period",
        operator: "lte",
        confidence: 0.95,
        summary: `before ${normalized}`,
        sourceText: dateBeforeMatch[0].trim(),
        value: { date: normalized },
      });
    }
  }

  const dateOnMatch = query.match(DATE_ON_PATTERN);
  const dateOn = dateOnMatch?.[1];
  if (dateOn && dateOnMatch?.[0]) {
    const normalized = normalizeDateConstraint(dateOn);
    if (normalized) {
      constraints.push({
        signalKey: "document_date",
        operator: "eq",
        confidence: 0.95,
        summary: `on ${normalized}`,
        sourceText: dateOnMatch[0].trim(),
        value: { date: normalized },
      });
    }
  }

  return {
    semanticQuery,
    lexicalQuery,
    constraints,
  };
};
