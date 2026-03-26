import type { ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import type { RetrievalSignalPolicy } from "../../settings/domain/retrievalSettings.js";
import { isMetadataSignalKey, metadataPathFromSignalKey } from "../../settings/domain/retrievalSettings.js";
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
const METADATA_FIELD_PATTERN = /(^|\s)([a-zA-Z][\w.-]*):(?:"([^"]+)"|([^\s]+))/g;

const normalizeSearchQuery = (query: string): string =>
  query
    .replace(LEADING_RETRIEVAL_VERB_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

const resolveMetadataSignalKeys = (signalPolicies: RetrievalSignalPolicy[]): Map<string, string> => {
  const aliases = new Map<string, string>();

  for (const policy of signalPolicies) {
    if (!isMetadataSignalKey(policy.signalKey)) {
      continue;
    }

    const metadataPath = metadataPathFromSignalKey(policy.signalKey);
    if (!metadataPath) {
      continue;
    }

    aliases.set(policy.signalKey.toLowerCase(), policy.signalKey);
    aliases.set(metadataPath.toLowerCase(), policy.signalKey);
  }

  return aliases;
};

export const parseQueryConstraints = (
  query: string,
  signalPolicies: RetrievalSignalPolicy[] = [],
): ParsedQueryInterpretation => {
  const constraints: ParsedQueryInterpretation["constraints"] = [];
  const semanticQuery = normalizeSearchQuery(query);
  const lexicalQuery = normalizeSearchQuery(query);
  const metadataSignalAliases = resolveMetadataSignalKeys(signalPolicies);

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

  for (const match of query.matchAll(METADATA_FIELD_PATTERN)) {
    const fieldName = match[2]?.trim();
    const rawValue = (match[3] ?? match[4] ?? "").trim();
    const sourceText = `${fieldName}:${match[3] ? `"${match[3]}"` : match[4]}`;

    if (!fieldName || !rawValue) {
      continue;
    }

    const signalKey = metadataSignalAliases.get(fieldName.toLowerCase());
    const metadataPath = signalKey ? metadataPathFromSignalKey(signalKey) : null;
    if (!signalKey || !metadataPath) {
      continue;
    }

    constraints.push({
      signalKey,
      operator: "match",
      confidence: 0.98,
      summary: `${metadataPath}:${rawValue}`,
      sourceText,
      value: { raw: rawValue },
    });
  }

  return {
    semanticQuery,
    lexicalQuery,
    constraints,
  };
};
