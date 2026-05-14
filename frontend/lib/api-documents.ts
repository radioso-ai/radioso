import { request, requestLongRunning } from './api-client'
import { withQuery } from './api-query'
import type {
  DocumentCreateRequest,
  DocumentCreateResponse,
  DocumentDetails,
  DocumentListResponse,
  DocumentSearchHistoryListResponse,
  DocumentSearchResponse,
  WebsiteCrawlEnqueueResponse,
  WebsiteCrawlJobListResponse,
  WebsiteCrawlJobStatus,
} from './api-types'

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

  async listDocuments(input?: { limit?: number; offset?: number; cursor?: string }): Promise<DocumentListResponse> {
    return request<DocumentListResponse>(withQuery('/document/', {
      limit: input?.limit,
      offset: input?.offset,
      cursor: input?.cursor,
    }), {
      method: "GET",
    }, { withApiToken: true })
  },

  async updateDocument(documentId: string, data: DocumentCreateRequest): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, { withApiToken: true })
  },

  async reprocessDocument(documentId: string): Promise<DocumentCreateResponse> {
    return request<DocumentCreateResponse>(`/document/${documentId}/reprocess`, {
      method: "POST",
    }, { withApiToken: true })
  },

  async deleteDocument(documentId: string): Promise<void> {
    await request<void>(`/document/${documentId}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async importDocument(file: File, title?: string): Promise<DocumentCreateResponse> {
    const formData = new FormData()
    formData.set("file", file)
    if (title?.trim()) {
      formData.set("title", title.trim())
    }

    return request<DocumentCreateResponse>("/document/import", {
      method: "POST",
      body: formData,
    }, { withApiToken: true })
  },

  async crawlWebsite(input: { url: string; limit?: number }): Promise<WebsiteCrawlEnqueueResponse> {
    return request<WebsiteCrawlEnqueueResponse>("/document/crawl", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    }, { withApiToken: true })
  },

  async listCrawlJobs(input?: { status?: WebsiteCrawlJobStatus; sinceMinutes?: number; limit?: number }): Promise<WebsiteCrawlJobListResponse> {
    return request<WebsiteCrawlJobListResponse>(withQuery('/document/crawl/jobs', {
      status: input?.status,
      sinceMinutes: input?.sinceMinutes,
      limit: input?.limit,
    }), {
      method: "GET",
    }, { withApiToken: true })
  },

  async deleteCrawlJob(jobId: string): Promise<void> {
    await request<void>(`/document/crawl/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }, { withApiToken: true })
  },

  async searchDocuments(data: {
    query: string
    metadataFilter?: Record<string, string | number | boolean | null>
  }): Promise<DocumentSearchResponse> {
    return requestLongRunning<DocumentSearchResponse>('/api/document/search', {
      method: 'POST',
      body: JSON.stringify(data),
    }, { withApiToken: true })
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
    return request<DocumentSearchResponse>(`/document/search/history/${searchId}`, {
      method: 'GET',
    }, { withApiToken: true })
  }
}
