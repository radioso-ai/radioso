import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../documents/contracts/index.js";

export type RetrievalSourceScope =
  | { mode: "all" }
  | { mode: "selected"; sourceIds: string[] };

export type RetrievalSourceFilter =
  | { constrained: false }
  | { constrained: true; sourceIds: string[]; includeUnassignedDocuments: boolean };

export const resolveRetrievalSourceFilter = (scope?: RetrievalSourceScope): RetrievalSourceFilter => {
  if (!scope || scope.mode === "all") {
    return { constrained: false };
  }
  const hasManualSourceSelection = scope.sourceIds.includes(MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);
  const sourceIds = scope.sourceIds.filter((sourceId) => sourceId !== MANUALLY_ADDED_DOCUMENTS_SOURCE_ID);

  return {
    constrained: true,
    sourceIds,
    includeUnassignedDocuments: hasManualSourceSelection,
  };
};
