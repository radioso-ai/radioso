import type { AttributeControlMode, AttributeFamilyId } from "../../settings/domain/retrievalSettings.js";

export interface RawDatePoint {
  value: string;
  sourceText: string;
}

export interface RawDateRange {
  start: string;
  end: string;
  sourceText: string;
}

export interface RawMoneyValue {
  amountText: string;
  currencyText?: string | null;
  sourceText: string;
}

export interface RawLocationValue {
  value: string;
  sourceText: string;
}

export interface RawStructuredAttributes {
  datePoints: RawDatePoint[];
  dateRanges: RawDateRange[];
  moneyValues: RawMoneyValue[];
  locations: RawLocationValue[];
}

export interface NormalizedDatePoint {
  value: string;
  granularity: "day";
  confidence: number;
  sourceText: string;
}

export interface NormalizedDateRange {
  start: string;
  end: string;
  confidence: number;
  sourceText: string;
}

export interface NormalizedMoneyValue {
  amount: number;
  currencyCode: string | null;
  confidence: number;
  sourceText: string;
}

export interface NormalizedLocationValue {
  matchKey: string;
  displayName: string;
  confidence: number;
  sourceText: string;
}

export interface StructuredAttributes {
  datePoints: NormalizedDatePoint[];
  dateRanges: NormalizedDateRange[];
  moneyValues: NormalizedMoneyValue[];
  locations: NormalizedLocationValue[];
}

export type QueryConstraintOperator = "gte" | "lte" | "match" | "eq";

export interface ParsedQueryConstraint {
  family: AttributeFamilyId;
  operator: QueryConstraintOperator;
  confidence: number;
  summary: string;
  sourceText: string;
  value:
    | { date: string }
    | { amount: number; currencyCode: string | null }
    | { matchKey: string; displayName: string };
}

export interface ParsedQueryInterpretation {
  semanticQuery: string;
  lexicalQuery: string;
  constraints: ParsedQueryConstraint[];
}

export interface AppliedConstraint {
  family: AttributeFamilyId;
  mode: AttributeControlMode;
  outcome: "applied" | "relaxed" | "skipped";
  summary: string;
}

export const emptyStructuredAttributes = (): StructuredAttributes => ({
  datePoints: [],
  dateRanges: [],
  moneyValues: [],
  locations: [],
});

export const renderStructuredAttributeSummary = (attributes: StructuredAttributes): string => {
  const parts: string[] = [];

  for (const range of attributes.dateRanges) {
    parts.push(`Dates: ${range.start} to ${range.end}`);
  }
  for (const date of attributes.datePoints) {
    parts.push(`Date: ${date.value}`);
  }
  for (const money of attributes.moneyValues) {
    parts.push(`Price: ${money.amount}${money.currencyCode ? ` ${money.currencyCode}` : ""}`);
  }
  for (const location of attributes.locations) {
    parts.push(`Location: ${location.displayName}`);
  }

  return parts.join(" | ");
};
