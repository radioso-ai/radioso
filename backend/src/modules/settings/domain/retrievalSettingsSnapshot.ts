import type {
  RetrievalMetadataRule,
  RetrievalSettingsRecord,
  RetrievalStrategyPreference,
} from "./retrievalSettings.js";

/**
 * Immutable, point-in-time copy of the tunable retrieval settings for a
 * workspace. Has no workspace identity and no timestamps — it is a value,
 * not a row. Use this anywhere you need to replay or audit "the retrieval
 * settings that were in effect at moment X" without depending on the live
 * row staying the same: eval replay, per-message retrieval-settings
 * persistence, future A/B experiments, etc.
 *
 * Lives here in the settings module because retrieval settings are owned
 * here. Consumers MUST NOT redefine this shape inside their own modules.
 */
export interface RetrievalSettingsSnapshot {
  queryRewriteEnabled: boolean;
  semanticRewriteInstructions: string;
  lexicalRewriteInstructions: string;
  suggestedQuestionsEnabled: boolean;
  suggestedQuestionsCount: number;
  rerankEnabled: boolean;
  vectorTopK: number;
  similarityThreshold: number;
  rerankTopK: number;
  citationDisplayEnabled: boolean;
  metadataRules: RetrievalMetadataRule[];
  customInstruction: string;
  retrievalStrategy?: RetrievalStrategyPreference;
}

export const freezeRetrievalSettings = (
  record: RetrievalSettingsRecord,
): RetrievalSettingsSnapshot => ({
  queryRewriteEnabled: record.queryRewriteEnabled,
  semanticRewriteInstructions: record.semanticRewriteInstructions,
  lexicalRewriteInstructions: record.lexicalRewriteInstructions,
  suggestedQuestionsEnabled: record.suggestedQuestionsEnabled,
  suggestedQuestionsCount: record.suggestedQuestionsCount,
  rerankEnabled: record.rerankEnabled,
  vectorTopK: record.vectorTopK,
  similarityThreshold: record.similarityThreshold,
  rerankTopK: record.rerankTopK,
  citationDisplayEnabled: record.citationDisplayEnabled,
  metadataRules: record.metadataRules,
  customInstruction: record.customInstruction,
  retrievalStrategy: record.retrievalStrategy,
});
