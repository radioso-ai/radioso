import type { DocumentCorpusChangeObserverPort } from "../../../modules/documents/contracts/corpusChangeObserver.js";
import type { ContentPlanCorpusInvalidationRepositoryPort } from "../../../modules/contentPlanning/services/corpusInvalidation.js";

/** Application-owned bridge from the Documents lifecycle to a durable Content Planning trigger. */
export class ContentPlanningDocumentCorpusObserver implements DocumentCorpusChangeObserverPort {
  private readonly clock: () => Date;

  constructor(
    private readonly invalidations: Pick<
      ContentPlanCorpusInvalidationRepositoryPort,
      "markWorkspaceDirty" | "invalidateDeletedDocument"
    >,
    clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async onCorpusChanged(input: {
    workspaceId: string;
    documentId?: string;
    change: "published" | "deleted";
  }): Promise<void> {
    const dirtyAt = this.clock();
    if (input.change === "deleted" && input.documentId) {
      await this.invalidations.invalidateDeletedDocument({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        dirtyAt,
      });
      return;
    }
    await this.invalidations.markWorkspaceDirty({ workspaceId: input.workspaceId, dirtyAt });
  }
}
