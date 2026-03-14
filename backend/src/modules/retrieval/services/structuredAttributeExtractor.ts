import type { RawStructuredAttributes } from "../domain/structuredAttributes.js";

const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/g;
const DATE_RANGE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|-|–)\s*(\d{4}-\d{2}-\d{2})\b/g;
const MONEY_PATTERN = /\b(\d+(?:\.\d{1,2})?)\s*(EUR|USD)\b|\$(\d+(?:\.\d{1,2})?)\b/g;
const LOCATION_LABEL_PATTERN = /location:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/gi;
const LOCATION_PROSE_PATTERN = /\bin\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)(?=[\s.,;!?]|$)/g;

export const extractRawStructuredAttributes = (content: string): RawStructuredAttributes => {
  const dateRanges: RawStructuredAttributes["dateRanges"] = [];
  const consumedDateTexts = new Set<string>();

  for (const match of content.matchAll(DATE_RANGE_PATTERN)) {
    const start = match[1];
    const end = match[2];
    const sourceText = match[0];
    if (!start || !end || !sourceText) {
      continue;
    }

    dateRanges.push({ start, end, sourceText });
    consumedDateTexts.add(start);
    consumedDateTexts.add(end);
  }

  const datePoints: RawStructuredAttributes["datePoints"] = [];
  for (const match of content.matchAll(DATE_PATTERN)) {
    const value = match[1];
    if (!value || consumedDateTexts.has(value)) {
      continue;
    }
    datePoints.push({ value, sourceText: value });
  }

  const moneyValues: RawStructuredAttributes["moneyValues"] = [];
  for (const match of content.matchAll(MONEY_PATTERN)) {
    if (match[1] && match[2]) {
      moneyValues.push({
        amountText: match[1],
        currencyText: match[2],
        sourceText: `${match[1]} ${match[2]}`,
      });
      continue;
    }
    if (match[3]) {
      moneyValues.push({
        amountText: match[3],
        currencyText: "USD",
        sourceText: `$${match[3]}`,
      });
    }
  }

  const locations: RawStructuredAttributes["locations"] = [];
  const seenLocations = new Set<string>();
  for (const pattern of [LOCATION_LABEL_PATTERN, LOCATION_PROSE_PATTERN]) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value && !seenLocations.has(value.toLowerCase())) {
        seenLocations.add(value.toLowerCase());
        locations.push({ value, sourceText: value });
      }
    }
  }

  return {
    datePoints,
    dateRanges,
    moneyValues,
    locations,
  };
};
