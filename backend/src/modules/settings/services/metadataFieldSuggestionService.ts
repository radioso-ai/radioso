import type { MetadataFieldSuggestion } from "../domain/retrievalSettings.js";
import { mergeMetadataFieldSuggestions } from "../domain/metadataFieldSuggestions.js";
import type {
  DeclaredMetadataFieldSourcePort,
  RetrievalMetadataFieldSourcePort,
} from "../contracts/services.js";

/**
 * The metadata-rule editor's field suggestions: the document type catalog's
 * declarations unioned with the keys already present on document metadata, so
 * an operator can filter on a field they just declared and on one a connector
 * or a person set by hand.
 */
export class MetadataFieldSuggestionService implements RetrievalMetadataFieldSourcePort {
  constructor(
    private readonly declared: DeclaredMetadataFieldSourcePort,
    private readonly observed: RetrievalMetadataFieldSourcePort,
  ) {}

  async listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]> {
    const [declared, observed] = await Promise.all([
      this.declared.listDeclaredMetadataFields(workspaceId),
      this.observed.listMetadataFieldSuggestions(workspaceId),
    ]);
    return mergeMetadataFieldSuggestions(declared, observed);
  }
}
