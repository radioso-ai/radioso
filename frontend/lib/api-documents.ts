import { request, requestLongRunning } from './api-client'
import { withQuery } from './api-query'
import type {
  DocumentChunkDetail,
  DocumentChunkListResponse,
  DocumentCreateRequest,
  DocumentCreateResponse,
  DocumentDetails,
  DocumentListResponse,
  DocumentMetadataRecord,
  DocumentRetrievalUpdateRequest,
  DocumentSourceCrawlSettings,
  DocumentSourceListItem,
  DocumentSourceListResponse,
  DocumentSearchHistoryListResponse,
  DocumentSearchResponse,
  SourceReprocessResponse,
  WebsiteCrawlEnqueueResponse,
  WebsiteCrawlJobListResponse,
  WebsiteCrawlJobStatus,
} from './api-types'

const normalizeDocumentSearchResponse = (payload: DocumentSearchResponse): DocumentSearchResponse => ({
  ...payload,
  activityTrace: payload.activityTrace ?? payload.debug?.activityTrace,
})

export const documentsApi = {
  async createDocument(data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>("/document/", {
      method: "POST",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async getDocument(documentId: string): Promise<DocumentDetails> {
    return request<DocumentDetails>(`/document/${documentId}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async listDocumentChunks(documentId: string): Promise<DocumentChunkListResponse> {
    return request<DocumentChunkListResponse>(`/document/${documentId}/chunks`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async getDocumentChunk(documentId: string, chunkId: string): Promise<DocumentChunkDetail> {
    return request<DocumentChunkDetail>(`/document/${documentId}/chunks/${chunkId}`, {
      method: "GET",
    }, { withApiToken: true })
  },

  async listDocuments(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentListResponse> {
    return request<DocumentListResponse>(withQuery('/document/', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: "GET",
    }, { withApiToken: true })
  },

  async listSources(): Promise<DocumentSourceListResponse> {
    return request<DocumentSourceListResponse>('/document/sources', {
      method: 'GET',
    }, { withApiToken: true })
  },

  async updateDocument(documentId: string, data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async updateDocumentRetrieval(
    documentId: string,
    data: DocumentRetrievalUpdateRequest,
  ): Promise<DocumentDetails> {
    return request<DocumentDetails>(`/document/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  /**
   * Replaces a document's tags wholesale. An empty record is sent as-is because
   * the route reads a present `metadata` as the full new set, so `{}` is how the
   * caller clears every tag.
   */
  async updateDocumentMetadata(
    documentId: string,
    metadata: DocumentMetadataRecord,
  ): Promise<DocumentDetails> {
    return request<DocumentDetails>(`/document/${documentId}`, {
      method: "PATCH",
      body: JSON.stringify({ metadata }),
    }, { withApiToken: true })
  },

  async reprocessDocument(documentId: string, input?: { documentEnrichmentOverride?: 'on' | 'off' }): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}/reprocess`, {
      method: "POST",
      ...(input?.documentEnrichmentOverride
        ? { body: JSON.stringify({ documentEnrichmentOverride: input.documentEnrichmentOverride }) }
        : {}),
    }, { withApiToken: true })
  },

  async deleteDocument(documentId: string): Promise<void> {
    await request<void>(`/document/${documentId}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async importDocument(
    file: File,
    title?: string,
    options?: { documentEnrichmentOverride?: 'on' | 'off'; metadata?: DocumentMetadataRecord },
  ): Promise<DocumentCreateResponse> {
    const formData = new FormData()
    formData.set("file", file)
    if (title?.trim()) {
      formData.set("title", title.trim())
    }
    if (options?.documentEnrichmentOverride) {
      formData.set("documentEnrichmentOverride", options.documentEnrichmentOverride)
    }
    // Multipart carries no JSON types, so tags ride as one serialized field. An
    // empty record is left out entirely: on create there is nothing to clear.
    if (options?.metadata && Object.keys(options.metadata).length > 0) {
      formData.set("metadata", JSON.stringify(options.metadata))
    }

    return request<DocumentCreateResponse>("/document/import", {
      method: "POST",
      body: formData,
    }, { withApiToken: true })
  },

  async crawlWebsite(input: {
    url: string
    limit?: number
    includeUrlPatterns?: string[]
    excludeUrlPatterns?: string[]
    preserveContentLinks?: boolean
  }): Promise<WebsiteCrawlEnqueueResponse> {
    return request<WebsiteCrawlEnqueueResponse>("/document/crawl", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.includeUrlPatterns !== undefined ? { includeUrlPatterns: input.includeUrlPatterns } : {}),
        ...(input.excludeUrlPatterns !== undefined ? { excludeUrlPatterns: input.excludeUrlPatterns } : {}),
        ...(input.preserveContentLinks !== undefined ? { preserveContentLinks: input.preserveContentLinks } : {}),
      }),
    }, { withApiToken: true })
  },

  async listCrawlJobs(input?: { status?: WebsiteCrawlJobStatus; sinceMinutes?: number; limit?: number; sourceId?: string }): Promise<WebsiteCrawlJobListResponse> {
    return request<WebsiteCrawlJobListResponse>(withQuery('/document/crawl/jobs', {
      status: input?.status,
      sinceMinutes: input?.sinceMinutes,
      limit: input?.limit,
      sourceId: input?.sourceId,
    }), {
      method: "GET",
    }, { withApiToken: true })
  },

  async deleteCrawlJob(jobId: string): Promise<void> {
    await request<void>(`/document/crawl/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async listSourceDocuments(sourceId: string, input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentListResponse> {
    return request<DocumentListResponse>(withQuery(`/document/sources/${encodeURIComponent(sourceId)}/documents`, {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: "GET",
    }, { withApiToken: true })
  },

  async recrawlSource(sourceId: string): Promise<WebsiteCrawlEnqueueResponse> {
    return request<WebsiteCrawlEnqueueResponse>(`/document/sources/${encodeURIComponent(sourceId)}/recrawl`, {
      method: "POST",
    }, { withApiToken: true })
  },

  async reprocessSource(sourceId: string, input?: { documentEnrichmentOverride?: 'on' | 'off' }): Promise<SourceReprocessResponse> {
    return request<SourceReprocessResponse>(`/document/sources/${encodeURIComponent(sourceId)}/reprocess`, {
      method: "POST",
      ...(input?.documentEnrichmentOverride
        ? { body: JSON.stringify({ documentEnrichmentOverride: input.documentEnrichmentOverride }) }
        : {}),
    }, { withApiToken: true })
  },

  async pauseSourceCrawl(sourceId: string): Promise<{ pausedJobCount: number }> {
    return request<{ pausedJobCount: number }>(`/document/sources/${encodeURIComponent(sourceId)}/pause-crawl`, {
      method: "POST",
    }, { withApiToken: true })
  },

  async resumeSourceCrawl(sourceId: string): Promise<{ resumedJobCount: number; pendingResumeJobCount?: number; resumeDispatchFailureCount?: number }> {
    return request<{ resumedJobCount: number; pendingResumeJobCount?: number; resumeDispatchFailureCount?: number }>(`/document/sources/${encodeURIComponent(sourceId)}/resume-crawl`, {
      method: "POST",
    }, { withApiToken: true })
  },

  async deleteSource(sourceId: string): Promise<void> {
    await request<void>(`/document/sources/${encodeURIComponent(sourceId)}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async updateSourceCrawlSettings(
    sourceId: string,
    crawlSettings: Partial<Omit<DocumentSourceCrawlSettings, 'url'>>,
  ): Promise<DocumentSourceListItem> {
    return request<DocumentSourceListItem>(`/document/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ crawlSettings }),
    }, { withApiToken: true })
  },

  async updateSourceEnrichmentOverride(
    sourceId: string,
    documentEnrichmentOverride: 'inherit' | 'on' | 'off',
  ): Promise<DocumentSourceListItem> {
    return request<DocumentSourceListItem>(`/document/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ documentEnrichmentOverride }),
    }, { withApiToken: true })
  },

  /**
   * Replaces the tag template a source stamps onto the documents it produces.
   * Already-ingested documents keep their current tags until the source is
   * reprocessed.
   */
  async updateSourceDocumentMetadata(
    sourceId: string,
    documentMetadata: DocumentMetadataRecord,
  ): Promise<DocumentSourceListItem> {
    return request<DocumentSourceListItem>(`/document/sources/${encodeURIComponent(sourceId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ documentMetadata }),
    }, { withApiToken: true })
  },

  async searchDocuments(data: {
    query: string
    metadataFilter?: Record<string, string | number | boolean | null>
  }): Promise<DocumentSearchResponse> {
    const payload = await requestLongRunning<DocumentSearchResponse>('/api/document/search', {
      method: 'POST',
      body: JSON.stringify({ ...data, includeDebug: true }),
    }, { withApiToken: true })
    return normalizeDocumentSearchResponse(payload)
  },

  async listSearchHistory(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentSearchHistoryListResponse> {
    return request<DocumentSearchHistoryListResponse>(withQuery('/document/search/history', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: 'GET',
    }, { withApiToken: true })
  },

  async getSearchHistory(searchId: string): Promise<DocumentSearchResponse> {
    const payload = await request<DocumentSearchResponse>(`/document/search/history/${searchId}?includeDebug=true`, {
      method: 'GET',
    }, { withApiToken: true })
    return normalizeDocumentSearchResponse(payload)
  }
}
