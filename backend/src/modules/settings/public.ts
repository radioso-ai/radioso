export { manualDocumentEnrichmentOverrides } from "./domain/ingestionSettings.js";
export type {
  IngestionSettingsFieldProposalApplyInput,
  IngestionSettingsFieldProposalApplyOutcome,
  IngestionSettingsFieldProposalPreparation,
  IngestionSettingsProposalPatch,
  IngestionSettingsProposalPort,
} from "./contracts/services.js";
export const ingestionSettingsChangeEffect = {
  appliesTo: "documents_processed_after_execution",
  existingDocuments: "unchanged_until_reprocessed",
  embeddingModel: "unchanged",
} as const;
export { websiteEmbedLauncherPositions } from "./domain/websiteEmbedSettings.js";
export * from "./copilotPrimitiveRegistry.js";
