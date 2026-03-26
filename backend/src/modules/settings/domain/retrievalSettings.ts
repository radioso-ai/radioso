import { randomUUID } from "node:crypto";

import { badRequest } from "../../../shared/domain/errors.js";

export const metadataRuleOperators = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "lt",
  "lte",
  "gt",
  "gte",
] as const;
export type MetadataRuleOperator = (typeof metadataRuleOperators)[number];

export const metadataRuleEffects = ["boost", "filter"] as const;
export type MetadataRuleEffect = (typeof metadataRuleEffects)[number];

export const metadataValueTypes = ["string", "number", "date", "boolean"] as const;
export type MetadataValueType = (typeof metadataValueTypes)[number];

export interface MetadataFieldSuggestion {
  field: string;
  inferredType: MetadataValueType;
}

export interface RetrievalMetadataRule {
  id: string;
  field: string;
  valueType: MetadataValueType;
  operator: MetadataRuleOperator;
  value: string;
  effect: MetadataRuleEffect;
  enabled: boolean;
}

interface RetrievalSettingsPayload {
  metadataRules?: unknown;
}

interface LegacyMetadataRule {
  id?: unknown;
  field?: unknown;
  valueType?: unknown;
  operator?: unknown;
  value?: unknown;
  effect?: unknown;
  enabled?: unknown;
}

export interface RetrievalSettingsRecord {
  workspaceId: string;
  queryRewriteEnabled: boolean;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  warmthLevel: number;
  citationDisplayEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  customInstruction: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RetrievalSettingsInput {
  queryRewriteEnabled: boolean;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  warmthLevel: number;
  citationDisplayEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  customInstruction: string;
}

// Kept for internal retrieval tests that still exercise query-derived attribute logic.
export const defaultAttributeControls = () => [
  { signalKey: "document_date", enabled: true, mode: "boost_only" as const },
  { signalKey: "document_period", enabled: true, mode: "boost_only" as const },
  { signalKey: "document_amount", enabled: true, mode: "boost_only" as const },
  { signalKey: "document_location", enabled: true, mode: "boost_only" as const },
];

export const defaultRetrievalSettings = (workspaceId: string): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: false,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  warmthLevel: 5,
  citationDisplayEnabled: true,
  metadataRules: [],
  customInstruction: "",
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const normalizeMetadataField = (value: string): string => value.trim();

export const createDefaultMetadataRule = (): RetrievalMetadataRule => ({
  id: randomUUID(),
  field: "",
  valueType: "string",
  operator: "equals",
  value: "",
  effect: "boost",
  enabled: true,
});

const isFieldSupported = (field: string): boolean => /^[A-Za-z0-9_.-]+$/.test(field);

export const allowedOperatorsForValueType = (valueType: MetadataValueType): MetadataRuleOperator[] => {
  if (valueType === "string") {
    return ["equals", "not_equals", "contains", "not_contains"];
  }
  if (valueType === "boolean") {
    return ["equals", "not_equals"];
  }

  return ["equals", "not_equals", "lt", "lte", "gt", "gte"];
};

const isIsoDateLike = (value: string): boolean => /^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(value.trim());

export const inferMetadataValueType = (value: unknown): MetadataValueType => {
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "string" && isIsoDateLike(value) && !Number.isNaN(Date.parse(value))) {
    return "date";
  }

  return "string";
};

const isBooleanLiteral = (value: string): boolean => /^(true|false)$/i.test(value.trim());
const isNumberLiteral = (value: string): boolean => value.trim().length > 0 && Number.isFinite(Number(value));
const isDateLiteral = (value: string): boolean => isIsoDateLike(value) && !Number.isNaN(Date.parse(value));

export const normalizeMetadataRules = (value: unknown): RetrievalMetadataRule[] => {
  const rawRules: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as RetrievalSettingsPayload).metadataRules)
      ? [...(((value as RetrievalSettingsPayload).metadataRules ?? []) as unknown[])]
      : [];

  const normalizedIds = new Set<string>();
  const normalizedRules: RetrievalMetadataRule[] = [];

  for (const entry of rawRules) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as LegacyMetadataRule;
    const field = typeof candidate.field === "string" ? normalizeMetadataField(candidate.field) : "";
    if (!field || !isFieldSupported(field)) {
      continue;
    }

    const ruleId =
      typeof candidate.id === "string" && candidate.id.trim().length > 0 && !normalizedIds.has(candidate.id.trim())
        ? candidate.id.trim()
        : randomUUID();
    normalizedIds.add(ruleId);

    normalizedRules.push({
      id: ruleId,
      field,
      valueType: metadataValueTypes.includes(candidate.valueType as MetadataValueType)
        ? (candidate.valueType as MetadataValueType)
        : inferMetadataValueType(candidate.value),
      operator: metadataRuleOperators.includes(candidate.operator as MetadataRuleOperator)
        ? (candidate.operator as MetadataRuleOperator)
        : "equals",
      value: typeof candidate.value === "string" ? candidate.value : String(candidate.value ?? ""),
      effect: metadataRuleEffects.includes(candidate.effect as MetadataRuleEffect)
        ? (candidate.effect as MetadataRuleEffect)
        : "boost",
      enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
    });
  }

  return normalizedRules;
};

export const validateRetrievalSettings = (input: RetrievalSettingsInput): RetrievalSettingsInput => {
  if (input.vectorTopK < 1 || input.vectorTopK > 300) {
    throw badRequest("vectorTopK must be between 1 and 300");
  }
  if (input.similarityThreshold < 0 || input.similarityThreshold > 1) {
    throw badRequest("similarityThreshold must be between 0 and 1");
  }
  if (input.rerankTopK < 1) {
    throw badRequest("rerankTopK must be greater than 0");
  }
  if (!Number.isInteger(input.warmthLevel) || input.warmthLevel < 1 || input.warmthLevel > 10) {
    throw badRequest("warmthLevel must be between 1 and 10");
  }
  if (!Array.isArray(input.metadataRules)) {
    throw badRequest("metadataRules must be an array");
  }

  const seenRuleIds = new Set<string>();
  for (const rule of input.metadataRules) {
    if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
      throw badRequest("metadataRules id must be a non-empty string");
    }
    if (seenRuleIds.has(rule.id)) {
      throw badRequest("metadataRules must not contain duplicate ids");
    }
    if (typeof rule.field !== "string" || normalizeMetadataField(rule.field).length === 0) {
      throw badRequest("metadataRules field must be a non-empty string");
    }
    if (!isFieldSupported(normalizeMetadataField(rule.field))) {
      throw badRequest("metadataRules field must use only letters, numbers, dots, underscores, or hyphens");
    }
    if (!metadataValueTypes.includes(rule.valueType)) {
      throw badRequest("metadataRules valueType must be supported");
    }
    if (!metadataRuleOperators.includes(rule.operator)) {
      throw badRequest("metadataRules operator must be supported");
    }
    if (!allowedOperatorsForValueType(rule.valueType).includes(rule.operator)) {
      throw badRequest("metadataRules operator must be valid for the selected valueType");
    }
    if (!metadataRuleEffects.includes(rule.effect)) {
      throw badRequest("metadataRules effect must be supported");
    }
    if (typeof rule.value !== "string") {
      throw badRequest("metadataRules value must be a string");
    }
    if (rule.valueType === "boolean" && !isBooleanLiteral(rule.value)) {
      throw badRequest("metadataRules boolean values must be true or false");
    }
    if (rule.valueType === "number" && !isNumberLiteral(rule.value)) {
      throw badRequest("metadataRules number values must be numeric");
    }
    if (rule.valueType === "date" && !isDateLiteral(rule.value)) {
      throw badRequest("metadataRules date values must use ISO format such as 2026-03-26");
    }
    if (typeof rule.enabled !== "boolean") {
      throw badRequest("metadataRules enabled must be a boolean");
    }

    seenRuleIds.add(rule.id);
  }

  if (typeof input.customInstruction !== "string") {
    throw badRequest("customInstruction must be a string");
  }
  if (input.customInstruction.length > 2000) {
    throw badRequest("customInstruction must not exceed 2000 characters");
  }

  return {
    ...input,
    metadataRules: input.metadataRules.map((rule) => ({
      ...rule,
      field: normalizeMetadataField(rule.field),
      value: rule.value.trim(),
    })),
  };
};
