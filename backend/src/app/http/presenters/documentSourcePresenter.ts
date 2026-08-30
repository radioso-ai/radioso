import type {
  DocumentSourceListRecord,
  DocumentSourceRecord,
} from "../../../db/repositories/documentSourceRepository.js";
import { parseDocumentSourceEnrichmentOverride } from "../../../modules/documents/domain/enrichment/enrichmentEnablement.js";
import { MANUALLY_ADDED_DOCUMENTS_SOURCE_ID } from "../../../modules/documents/domain/sourceConstants.js";
import { parseSourceDocumentMetadata } from "../../../modules/documents/domain/sourceDocumentMetadata.js";
import { resolveWebsiteCrawlerConfig } from "../../../modules/websiteCrawler/config.js";
import type { WorkspaceDocumentSourceStatus } from "../../../modules/documents/contracts/index.js";

export interface WebsiteSourceCrawlSettings {
  url: string | null;
  limit: number;
  includeUrlPatterns: string[];
  excludeUrlPatterns: string[];
  preserveContentLinks: boolean;
}

export const toCrawlSettings = (config: Record<string, unknown>): WebsiteSourceCrawlSettings => {
  const policy = config.policy && typeof config.policy === "object" && !Array.isArray(config.policy)
    ? (config.policy as Record<string, unknown>)
    : {};
  const includeUrlPatterns = Array.isArray(policy.includeUrlPatterns)
    ? policy.includeUrlPatterns.filter((value): value is string => typeof value === "string")
    : [];
  const excludeUrlPatterns = Array.isArray(policy.excludeUrlPatterns)
    ? policy.excludeUrlPatterns.filter((value): value is string => typeof value === "string")
    : [];

  return {
    url: typeof config.url === "string" ? config.url : null,
    limit:
      typeof config.limit === "number" && Number.isInteger(config.limit) && config.limit > 0
        ? config.limit
        : resolveWebsiteCrawlerConfig().defaultLimit,
    includeUrlPatterns,
    excludeUrlPatterns,
    preserveContentLinks: typeof policy.preserveContentLinks === "boolean" ? policy.preserveContentLinks : true,
  };
};

export const buildSyntheticManualDocumentSource = (
  workspaceId: string,
  documentCount: number,
): DocumentSourceListRecord => ({
  id: MANUALLY_ADDED_DOCUMENTS_SOURCE_ID,
  workspaceId,
  kind: "upload",
  name: "Manually added documents",
  externalId: null,
  config: {},
  metadata: {},
  lastSyncStatus: null,
  lastSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  documentCount,
});

export const presentDocumentSource = (
  source: Pick<DocumentSourceRecord, "id" | "kind" | "name" | "externalId" | "config" | "lastSyncStatus" | "lastSyncedAt" | "createdAt" | "updatedAt">,
  documentCount = 0,
) => ({
  id: source.id,
  kind: source.kind,
  name: source.name,
  externalId: source.externalId,
  lastSyncStatus: source.lastSyncStatus,
  lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
  createdAt: source.createdAt.toISOString(),
  updatedAt: source.updatedAt.toISOString(),
  documentCount,
  documentEnrichmentOverride: parseDocumentSourceEnrichmentOverride(source.config.documentEnrichmentOverride),
  documentMetadata: parseSourceDocumentMetadata(source.config),
  ...(source.kind === "website" ? { crawlSettings: toCrawlSettings(source.config) } : {}),
});

export const presentDocumentSourceList = (
  workspaceId: string,
  sources: ReadonlyArray<DocumentSourceListRecord | WorkspaceDocumentSourceStatus>,
  documentsWithoutSourceCount: number,
) => {
  const allSources = documentsWithoutSourceCount > 0
    ? [...sources, buildSyntheticManualDocumentSource(workspaceId, documentsWithoutSourceCount)]
    : sources;

  return {
    sources: allSources.map((source) => presentDocumentSource(source, source.documentCount)),
  };
};

export const applySourceDocumentMetadataPatch = (
  currentConfig: Record<string, unknown>,
  documentMetadata: unknown,
): Record<string, unknown> => ({
  ...currentConfig,
  documentMetadata: parseSourceDocumentMetadata({ documentMetadata }),
});

export const applyDocumentEnrichmentOverridePatch = (
  currentConfig: Record<string, unknown>,
  documentEnrichmentOverride: unknown,
): Record<string, unknown> => ({
  ...currentConfig,
  documentEnrichmentOverride: parseDocumentSourceEnrichmentOverride(documentEnrichmentOverride),
});

export const applyWebsiteCrawlSettingsPatch = (
  currentConfig: Record<string, unknown>,
  input: Partial<WebsiteSourceCrawlSettings>,
): Record<string, unknown> => {
  const previous = toCrawlSettings(currentConfig);
  const crawlerConfig = resolveWebsiteCrawlerConfig();

  return {
    ...currentConfig,
    limit: input.limit !== undefined ? Math.min(input.limit, crawlerConfig.maxLimit) : previous.limit,
    policy: {
      includeUrlPatterns: input.includeUrlPatterns ?? previous.includeUrlPatterns,
      excludeUrlPatterns: input.excludeUrlPatterns ?? previous.excludeUrlPatterns,
      preserveContentLinks: input.preserveContentLinks ?? previous.preserveContentLinks,
    },
  };
};
