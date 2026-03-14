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
  /\bin\s+([a-z][a-z]+(?:\s+[a-z][a-z]+)*)(?=\s+(?:under|below|less than|over|above|more than|after|before|on)\b|[?.!,]|$)/i;
const LEADING_RETRIEVAL_VERB_PATTERN = /^(?:find|show|list|search for|search)\s+/i;

const normalizeSearchQuery = (query: string): string =>
  query
    .replace(LEADING_RETRIEVAL_VERB_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

const removeConstraintText = (query: string, pattern: RegExp): string => normalizeSearchQuery(query.replace(pattern, " "));

export const parseQueryConstraints = (query: string): ParsedQueryInterpretation => {
  const constraints: ParsedQueryInterpretation["constraints"] = [];
  let semanticQuery = query;
  let lexicalQuery = query;

  const location = query.match(LOCATION_PATTERN)?.[1];
  if (location) {
    const normalized = normalizeLocationConstraint(location);
    if (normalized) {
      constraints.push({
        family: "location",
        operator: "match",
        confidence: 0.95,
        summary: `in ${normalized.displayName}`,
        value: normalized,
      });
      semanticQuery = removeConstraintText(semanticQuery, LOCATION_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, LOCATION_PATTERN);
    }
  }

  const moneyLte = query.match(MONEY_LTE_PATTERN);
  if (moneyLte?.[1]) {
    const normalized = normalizeMoneyConstraint(moneyLte[1], moneyLte[2] ?? null);
    if (normalized) {
      constraints.push({
        family: "money_value",
        operator: "lte",
        confidence: 0.95,
        summary: `under ${normalized.amount}${normalized.currencyCode ? ` ${normalized.currencyCode}` : ""}`,
        value: normalized,
      });
      semanticQuery = removeConstraintText(semanticQuery, MONEY_LTE_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, MONEY_LTE_PATTERN);
    }
  }

  const moneyGte = query.match(MONEY_GTE_PATTERN);
  if (moneyGte?.[1]) {
    const normalized = normalizeMoneyConstraint(moneyGte[1], moneyGte[2] ?? null);
    if (normalized) {
      constraints.push({
        family: "money_value",
        operator: "gte",
        confidence: 0.95,
        summary: `over ${normalized.amount}${normalized.currencyCode ? ` ${normalized.currencyCode}` : ""}`,
        value: normalized,
      });
      semanticQuery = removeConstraintText(semanticQuery, MONEY_GTE_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, MONEY_GTE_PATTERN);
    }
  }

  const dateAfter = query.match(DATE_AFTER_PATTERN)?.[1];
  if (dateAfter) {
    const normalized = normalizeDateConstraint(dateAfter);
    if (normalized) {
      constraints.push({
        family: "date_range",
        operator: "gte",
        confidence: 0.95,
        summary: `after ${normalized}`,
        value: { date: normalized },
      });
      semanticQuery = removeConstraintText(semanticQuery, DATE_AFTER_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, DATE_AFTER_PATTERN);
    }
  }

  const dateBefore = query.match(DATE_BEFORE_PATTERN)?.[1];
  if (dateBefore) {
    const normalized = normalizeDateConstraint(dateBefore);
    if (normalized) {
      constraints.push({
        family: "date_range",
        operator: "lte",
        confidence: 0.95,
        summary: `before ${normalized}`,
        value: { date: normalized },
      });
      semanticQuery = removeConstraintText(semanticQuery, DATE_BEFORE_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, DATE_BEFORE_PATTERN);
    }
  }

  const dateOn = query.match(DATE_ON_PATTERN)?.[1];
  if (dateOn) {
    const normalized = normalizeDateConstraint(dateOn);
    if (normalized) {
      constraints.push({
        family: "date_point",
        operator: "eq",
        confidence: 0.95,
        summary: `on ${normalized}`,
        value: { date: normalized },
      });
      semanticQuery = removeConstraintText(semanticQuery, DATE_ON_PATTERN);
      lexicalQuery = removeConstraintText(lexicalQuery, DATE_ON_PATTERN);
    }
  }

  return {
    semanticQuery: normalizeSearchQuery(semanticQuery || query),
    lexicalQuery: normalizeSearchQuery(lexicalQuery || query),
    constraints,
  };
};
