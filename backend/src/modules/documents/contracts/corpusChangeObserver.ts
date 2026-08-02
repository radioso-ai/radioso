export type DocumentCorpusChange = "published" | "deleted";

/**
 * Consumer-neutral lifecycle seam for projections derived from the workspace
 * corpus. Implementations must persist their trigger before resolving.
 */
export interface DocumentCorpusChangeObserverPort {
  onCorpusChanged(input: {
    workspaceId: string;
    documentId?: string;
    change: DocumentCorpusChange;
  }): Promise<void>;
}
