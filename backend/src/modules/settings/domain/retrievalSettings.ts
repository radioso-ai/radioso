import { badRequest } from "../../../shared/domain/errors.js";

export interface RetrievalSettingsRecord {
  accountId: string;
  queryRewriteEnabled: boolean;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  warmthLevel: number;
  citationDisplayEnabled: boolean;
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
}

export const defaultRetrievalSettings = (accountId: string): RetrievalSettingsRecord => ({
  accountId,
  queryRewriteEnabled: false,
  rerankEnabled: false,
  vectorTopK: 15,
  similarityThreshold: 0.2,
  rerankTopK: 5,
  warmthLevel: 5,
  citationDisplayEnabled: true,
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

  return input;
};
