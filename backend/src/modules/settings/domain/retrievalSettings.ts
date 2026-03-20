import { badRequest } from "../../../shared/domain/errors.js";
import { chunkingStrategyIds, type ChunkingStrategyId } from "../../retrieval/domain/chunking/chunkingStrategy.js";

export const attributeFamilyIds = ["date_point", "date_range", "money_value", "location"] as const;
export type AttributeFamilyId = (typeof attributeFamilyIds)[number];

export const attributeControlModes = ["boost_only", "hard_filter"] as const;
export type AttributeControlMode = (typeof attributeControlModes)[number];

export interface AttributeFamilyControl {
  family: AttributeFamilyId;
  enabled: boolean;
  mode: AttributeControlMode;
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
  chunkingStrategy: ChunkingStrategyId;
  attributeControls: AttributeFamilyControl[];
  customInstruction: string;
  inferenceAnswerEnabled: boolean;
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
  chunkingStrategy: ChunkingStrategyId;
  attributeControls: AttributeFamilyControl[];
  customInstruction: string;
  inferenceAnswerEnabled: boolean;
}

export const defaultAttributeControls = (): AttributeFamilyControl[] =>
  attributeFamilyIds.map((family) => ({
    family,
    enabled: true,
    mode: "boost_only",
  }));

export const defaultRetrievalSettings = (workspaceId: string): RetrievalSettingsRecord => ({
  workspaceId,
  queryRewriteEnabled: false,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  warmthLevel: 5,
  citationDisplayEnabled: true,
  chunkingStrategy: "fixed_window",
  attributeControls: defaultAttributeControls(),
  customInstruction: "",
  inferenceAnswerEnabled: false,
  createdAt: new Date(),
  updatedAt: new Date(),
});

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
  if (!chunkingStrategyIds.includes(input.chunkingStrategy)) {
    throw badRequest("chunkingStrategy must be a supported strategy");
  }
  if (!Array.isArray(input.attributeControls)) {
    throw badRequest("attributeControls must be an array");
  }

  const seenFamilies = new Set<string>();
  for (const control of input.attributeControls) {
    if (!attributeFamilyIds.includes(control.family)) {
      throw badRequest("attributeControls family must be supported");
    }
    if (seenFamilies.has(control.family)) {
      throw badRequest("attributeControls must not contain duplicate families");
    }
    if (!attributeControlModes.includes(control.mode)) {
      throw badRequest("attributeControls mode must be supported");
    }
    if (typeof control.enabled !== "boolean") {
      throw badRequest("attributeControls enabled must be a boolean");
    }

    seenFamilies.add(control.family);
  }

  if (seenFamilies.size !== attributeFamilyIds.length) {
    throw badRequest("attributeControls must include every supported family");
  }

  if (typeof input.customInstruction !== "string") {
    throw badRequest("customInstruction must be a string");
  }
  if (input.customInstruction.length > 2000) {
    throw badRequest("customInstruction must not exceed 2000 characters");
  }

  if (typeof input.inferenceAnswerEnabled !== "boolean") {
    throw badRequest("inferenceAnswerEnabled must be a boolean");
  }

  return input;
};
