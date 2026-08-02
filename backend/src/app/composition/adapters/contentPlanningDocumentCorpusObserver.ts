import type { DocumentCorpusChangeObserverPort } from "../../../modules/documents/contracts/corpusChangeObserver.js";
import type { ContentPlanEnrichmentTriggerPort } from "../../../modules/contentPlanning/services/enrichmentPlanningService.js";

/** Application-owned bridge from the Documents lifecycle to a durable Content Planning trigger. */
export class ContentPlanningDocumentCorpusObserver implements DocumentCorpusChangeObserverPort {
  private readonly clock: () => Date;

  constructor(
    private readonly trigger: Pick<ContentPlanEnrichmentTriggerPort, "invalidateWorkspaceCorpusEvidence">,
    clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
  }

  async onCorpusChanged(input: {
    workspaceId: string;
    documentId?: string;
    change: "published" | "deleted";
  }): Promise<void> {
    await this.trigger.invalidateWorkspaceCorpusEvidence({
      workspaceId: input.workspaceId,
      dirtyAt: this.clock(),
    });
  }
}
