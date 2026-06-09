import type { RetrievalDefaultsProvider } from "../../modules/retrieval/public.js";
import { defaultRetrievalSettings } from "../../modules/settings/contracts/retrieval.js";
import { RETRIEVAL_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";

export const createSystemRetrievalDefaultsProvider = (): RetrievalDefaultsProvider => ({
  getDefaults(workspaceId) {
    return {
      ...defaultRetrievalSettings(workspaceId),
      similarityThreshold: RETRIEVAL_BEHAVIOR.defaultSimilarityThreshold,
      workspaceId,
    };
  },
});
