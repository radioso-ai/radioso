import type { RetrievalSettingsRecord } from "../../settings/contracts/retrieval.js";

export interface RetrievalDefaultsProvider {
  getDefaults(workspaceId: string): RetrievalSettingsRecord;
}
