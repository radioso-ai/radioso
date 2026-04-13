import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import type { ParsedQueryConstraint, ParsedQueryInterpretation } from "../domain/structuredAttributes.js";
import {
  isRetrievalConstraintOperator,
  isRetrievalConstraintSignalKey,
  renderRetrievalConstraintOperatorPromptSection,
  renderRetrievalConstraintPromptSection,
} from "../domain/retrievalConstraintSchema.js";
import {
  normalizeDateConstraint,
  normalizeLocationConstraint,
  normalizeMoneyConstraint,
} from "./attributeNormalizer.js";

const DEFAULT_PARSED_QUERY = (query: string): ParsedQueryInterpretation => ({
  semanticQuery: query.trim(),
  lexicalQuery: query.trim(),
  constraints: [],
});

const SEMANTIC_QUERY_CONSTRAINT_SYSTEM_PROMPT = `Interpret the user's query for retrieval.
Return strict JSON only.

Goals:
- Detect semantic constraints regardless of the query language.
- Do not rely on English-only patterns.
- Prefer typed constraints over prose explanations.
- Preserve the user's intent and language.

You may emit these signal keys only:
${renderRetrievalConstraintPromptSection()}

Operators allowed:
${renderRetrievalConstraintOperatorPromptSection()}

Rules:
- If the query mentions a calendar month and year like "May 2026" or "maggio 2026", convert it into TWO document_period constraints:
  - gte first day of month
  - lte last day of month
- If the query mentions only a month without a year, keep the query text but do not invent a year.
- Never treat month names as locations.
- Use ISO dates YYYY-MM-DD.
- For money, return amount as a number and currencyCode when known, otherwise null.
- For locations, return displayName and matchKey.
- sourceText should be the exact relevant phrase from the user query when possible.

Return this shape exactly:
{"semanticQuery":"string","lexicalQuery":"string","constraints":[{"signalKey":"document_period","operator":"gte","confidence":0.0,"summary":"string","sourceText":"string","value":{"date":"YYYY-MM-DD"}}]}
`;

interface SemanticConstraintGatewayResult {
  semanticQuery?: string;
  lexicalQuery?: string;
  constraints?: Array<{
    signalKey?: string;
    operator?: string;
    confidence?: number;
    summary?: string;
    sourceText?: string;
    value?:
      | { date?: string }
      | { amount?: number; currencyCode?: string | null }
      | { matchKey?: string; displayName?: string };
  }>;
}

export interface SemanticQueryConstraintGateway {
  interpret(input: {
    query: string;
    history: MessageRecord[];
  }): Promise<SemanticConstraintGatewayResult>;
}

export class ModelSemanticQueryConstraintGateway implements SemanticQueryConstraintGateway {
  constructor(private readonly client: TextGenerationClient) {}

  async interpret(input: { query: string; history: MessageRecord[] }): Promise<SemanticConstraintGatewayResult> {
    const history = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");

    const raw = await this.client.complete({
      systemPrompt: SEMANTIC_QUERY_CONSTRAINT_SYSTEM_PROMPT,
      prompt: `Conversation context:\n${history || "No prior context"}\n\nLatest user query:\n${input.query}`,
      temperature: 0,
      maxOutputTokens: 500,
    });

    return parseSemanticConstraintResult(raw);
  }
}

export class SemanticQueryConstraintService {
  constructor(private readonly gateway?: SemanticQueryConstraintGateway) {}

  async interpret(input: {
    query: string;
    history: MessageRecord[];
  }): Promise<ParsedQueryInterpretation> {
    const trimmedQuery = input.query.trim();
    if (!trimmedQuery) {
      return DEFAULT_PARSED_QUERY(input.query);
    }

    if (!this.gateway) {
      return DEFAULT_PARSED_QUERY(input.query);
    }

    try {
      const result = await this.gateway.interpret(input);
      return normalizeSemanticInterpretation(input.query, result);
    } catch {
      return DEFAULT_PARSED_QUERY(input.query);
    }
  }
}

const parseSemanticConstraintResult = (raw: string): SemanticConstraintGatewayResult => {
  const normalized = raw.trim().replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/i, "").trim();
  return JSON.parse(normalized) as SemanticConstraintGatewayResult;
};

const normalizeQueryText = (value: string | undefined, fallback: string): string => {
  const normalized = (value ?? "").trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : fallback;
};

const normalizeSemanticInterpretation = (
  originalQuery: string,
  result: SemanticConstraintGatewayResult,
): ParsedQueryInterpretation => ({
  semanticQuery: normalizeQueryText(result.semanticQuery, originalQuery.trim()),
  lexicalQuery: normalizeQueryText(result.lexicalQuery, originalQuery.trim()),
  constraints: normalizeConstraints(result.constraints),
});

type GatewayConstraintValue =
  | { date?: string }
  | { amount?: number; currencyCode?: string | null }
  | { matchKey?: string; displayName?: string }
  | undefined;

const isGatewayLocationValue = (
  value: GatewayConstraintValue,
): value is { matchKey?: string; displayName?: string } =>
  typeof value === "object" &&
  value !== null &&
  ("matchKey" in value || "displayName" in value);

const isGatewayMoneyValue = (
  value: GatewayConstraintValue,
): value is { amount?: number; currencyCode?: string | null } =>
  typeof value === "object" &&
  value !== null &&
  ("amount" in value || "currencyCode" in value);

const isGatewayDateValue = (value: GatewayConstraintValue): value is { date?: string } =>
  typeof value === "object" && value !== null && "date" in value;

const normalizeConstraints = (constraints?: SemanticConstraintGatewayResult["constraints"]): ParsedQueryConstraint[] => {
  if (!Array.isArray(constraints)) {
    return [];
  }

  const parsedConstraints: ParsedQueryConstraint[] = [];

  for (const constraint of constraints) {
    const signalKey = normalizeSignalKey(constraint?.signalKey);
    const operator = normalizeOperator(signalKey, constraint?.operator);
    const summary = typeof constraint?.summary === "string" ? constraint.summary.trim() : "";
    const sourceText = typeof constraint?.sourceText === "string" ? constraint.sourceText.trim() : "";
    const confidence = typeof constraint?.confidence === "number" ? clampConfidence(constraint.confidence) : 0.8;
    const value = constraint?.value as GatewayConstraintValue;

    if (!signalKey || !operator) {
      continue;
    }

    if (signalKey === "document_location") {
      const locationValue = isGatewayLocationValue(value) ? value : undefined;
      const normalizedLocation = normalizeLocationConstraint(
        typeof locationValue?.displayName === "string"
          ? locationValue.displayName
          : typeof locationValue?.matchKey === "string"
            ? locationValue.matchKey
            : "",
      );
      if (!normalizedLocation) {
        continue;
      }
      parsedConstraints.push({
        signalKey,
        operator,
        confidence,
        summary: summary || `in ${normalizedLocation.displayName}`,
        sourceText,
        value: normalizedLocation,
      });
      continue;
    }

    if (signalKey === "document_amount") {
      const moneyValue = isGatewayMoneyValue(value) ? value : undefined;
      const amount = typeof moneyValue?.amount === "number" ? moneyValue.amount : NaN;
      const normalizedMoney = normalizeMoneyConstraint(String(amount), moneyValue?.currencyCode ?? null);
      if (!normalizedMoney) {
        continue;
      }
      parsedConstraints.push({
        signalKey,
        operator,
        confidence,
        summary:
          summary ||
          `${operator === "lte" ? "under" : operator === "gte" ? "over" : "amount"} ${normalizedMoney.amount}${
            normalizedMoney.currencyCode ? ` ${normalizedMoney.currencyCode}` : ""
          }`,
        sourceText,
        value: normalizedMoney,
      });
      continue;
    }

    const dateValue = isGatewayDateValue(value) ? value : undefined;
    const date = normalizeDateConstraint(typeof dateValue?.date === "string" ? dateValue.date : "");
    if (!date) {
      continue;
    }

    parsedConstraints.push({
      signalKey,
      operator,
      confidence,
      summary:
        summary ||
        `${operator === "gte" ? "after" : operator === "lte" ? "before" : "on"} ${date}`,
      sourceText,
      value: { date },
    });
  }

  return parsedConstraints;
};

const normalizeSignalKey = (value?: string): ParsedQueryConstraint["signalKey"] | null => {
  if (!value || !isRetrievalConstraintSignalKey(value)) {
    return null;
  }

  return value;
};

const normalizeOperator = (
  signalKey: ParsedQueryConstraint["signalKey"] | null,
  value?: string,
): ParsedQueryConstraint["operator"] | null => {
  if (!signalKey || !value) {
    return null;
  }

  if (!isRetrievalConstraintOperator(signalKey, value)) {
    return null;
  }

  return value;
};

const clampConfidence = (value: number): number => Math.max(0, Math.min(1, value));
