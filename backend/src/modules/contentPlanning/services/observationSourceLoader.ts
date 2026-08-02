import {
  MAX_CONTENT_PLAN_SOURCE_HYDRATION,
  type ContentPlanObservationSourcePort,
  type ContentPlanObservationSourceRecord,
} from "../contracts/persistence.js";
import {
  MAX_HISTORICAL_CONTEXT_MESSAGES,
  resolveHistoricalObservationSource,
  resolvePendingStructuredObservationSource,
  resolveStructuredObservationSource,
  type HistoricalInteractionInterpreterPort,
  type ObservationSourceMessage,
  type ObservationSourceResolution,
} from "./observationSourceResolver.js";

/** Message-owned history read; adapters must enforce workspace/conversation scope. */
export interface HistoricalConversationSourcePort {
  loadContext(input: {
    workspaceId: string;
    conversationId: string;
    sourceUserMessageId: string;
    limit: number;
  }): Promise<ObservationSourceMessage[]>;
}

export interface ObservationSemanticSourceBatch {
  items: Array<{
    observationId: string;
    resolution: ObservationSourceResolution;
  }>;
  requestedCount: number;
  loadedCount: number;
  truncatedCount: number;
}

const distinctBoundedObservationIds = (
  observationIds: readonly string[],
): { ids: string[]; distinctCount: number } => {
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const id of observationIds) {
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    distinct.push(id);
  }
  return {
    ids: distinct.slice(0, MAX_CONTENT_PLAN_SOURCE_HYDRATION),
    distinctCount: distinct.length,
  };
};

const structuredResolutionForRecord = (
  record: ContentPlanObservationSourceRecord,
): ObservationSourceResolution =>
  record.semanticIntentId === "unresolved" && record.semanticTextHash === null
    ? resolvePendingStructuredObservationSource({
        messageMetadata: record.sourceUserMetadata,
        legacyAuditMetadata: record.auditMetadata,
      })
    : resolveStructuredObservationSource({
        semanticIntentId: record.semanticIntentId,
        semanticTextHash: record.semanticTextHash,
        messageMetadata: record.sourceUserMetadata,
        legacyAuditMetadata: record.auditMetadata,
        rawSourceContent: record.sourceUserContent,
      });

/**
 * Hydrates a small observation batch from message-owned sources. Raw message content
 * crosses this boundary only for bounded historical interpretation and is never used
 * directly as a semantic/embedding input.
 */
export class ObservationSemanticSourceLoader {
  constructor(
    private readonly sources: ContentPlanObservationSourcePort,
    private readonly conversationSources?: HistoricalConversationSourcePort,
    private readonly interpreter?: HistoricalInteractionInterpreterPort,
  ) {}

  async load(input: {
    workspaceId: string;
    observationIds: readonly string[];
  }): Promise<ObservationSemanticSourceBatch> {
    const bounded = distinctBoundedObservationIds(input.observationIds);
    if (bounded.ids.length === 0) {
      return {
        items: [],
        requestedCount: 0,
        loadedCount: 0,
        truncatedCount: 0,
      };
    }
    const loaded = await this.sources.loadSources({
      workspaceId: input.workspaceId,
      observationIds: bounded.ids,
      limit: MAX_CONTENT_PLAN_SOURCE_HYDRATION,
    });
    const requested = new Set(bounded.ids);
    const recordsById = new Map<string, ContentPlanObservationSourceRecord>();
    for (const record of loaded.slice(0, MAX_CONTENT_PLAN_SOURCE_HYDRATION)) {
      if (requested.has(record.observationId) && !recordsById.has(record.observationId)) {
        recordsById.set(record.observationId, record);
      }
    }

    const items: ObservationSemanticSourceBatch["items"] = [];
    for (const observationId of bounded.ids) {
      const record = recordsById.get(observationId);
      if (!record) {
        items.push({
          observationId,
          resolution: { status: "unavailable", reason: "source_unavailable" },
        });
        continue;
      }
      const structured = structuredResolutionForRecord(record);
      if (
        structured.status === "resolved" ||
        structured.reason === "hash_mismatch" ||
        !this.conversationSources ||
        !this.interpreter
      ) {
        items.push({ observationId, resolution: structured });
        continue;
      }
      const messages = await this.conversationSources.loadContext({
        workspaceId: input.workspaceId,
        conversationId: record.conversationId,
        sourceUserMessageId: record.sourceUserMessageId,
        limit: MAX_HISTORICAL_CONTEXT_MESSAGES,
      });
      const resolution = await resolveHistoricalObservationSource({
        sourceUserMessageId: record.sourceUserMessageId,
        semanticIntentId: record.semanticIntentId,
        semanticTextHash: record.semanticTextHash,
        messages,
        legacyAuditMetadata: record.auditMetadata,
        interpreter: this.interpreter,
      });
      items.push({ observationId, resolution });
    }

    return {
      items,
      requestedCount: bounded.ids.length,
      loadedCount: recordsById.size,
      truncatedCount: Math.max(0, bounded.distinctCount - bounded.ids.length),
    };
  }
}
