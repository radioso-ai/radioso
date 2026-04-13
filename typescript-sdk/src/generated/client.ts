import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "./types.js";

export type RetrievalSettings = components["schemas"]["RetrievalSettings"];
export type UpdateRetrievalSettingsRequest = components["schemas"]["UpdateRetrievalSettingsRequest"];
export type IngestionSettings = components["schemas"]["IngestionSettings"];
export type UpdateIngestionSettingsRequest = components["schemas"]["UpdateIngestionSettingsRequest"];
export type GeneralSettingsResponse = components["schemas"]["GeneralSettingsResponse"];
export type UpdateGeneralSettingsRequest = components["schemas"]["UpdateGeneralSettingsRequest"];
export type WorkspaceIngestionReprocessResponse = components["schemas"]["WorkspaceIngestionReprocessResponse"];
export type DocumentCreateRequest = components["schemas"]["DocumentCreateRequest"];
export type DocumentOperationResponse = components["schemas"]["DocumentOperationResponse"];
export type DocumentListResponse = components["schemas"]["DocumentListResponse"];
export type DocumentDetails = components["schemas"]["DocumentDetails"];
export type DocumentSearchRequest = components["schemas"]["DocumentSearchRequest"];
export type DocumentSearchResponse = components["schemas"]["DocumentSearchResponse"];
export type DocumentSearchHistoryListResponse = components["schemas"]["DocumentSearchHistoryListResponse"];
export type ChatRequest = components["schemas"]["ChatRequest"];
export type ChatResponse = components["schemas"]["ChatResponse"];
export type ChatHistoryListResponse = components["schemas"]["ChatHistoryListResponse"];
export type ChatConversationDetail = components["schemas"]["ChatConversationDetail"];
export type ChatCreateRequest = Omit<ChatRequest, "stream"> & { stream?: false };

export interface PaginationQuery {
  limit?: number;
  offset?: number;
  cursor?: string;
}

export type DocumentListQuery = PaginationQuery;

export interface UpdateDocumentRequest {
  title: string;
  content: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export class GeneratedRadiosoClient {
  constructor(private readonly config: InternalClientConfig) {}

  getRetrievalSettings(): Promise<RetrievalSettings> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/settings/retrieval",
    });
  }

  updateRetrievalSettings(body: UpdateRetrievalSettingsRequest): Promise<RetrievalSettings> {
    return requestJson(this.config, {
      method: "PUT",
      path: "/api/v1/settings/retrieval",
      body,
    });
  }

  getIngestionSettings(): Promise<IngestionSettings> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/settings/ingestion",
    });
  }

  updateIngestionSettings(body: UpdateIngestionSettingsRequest): Promise<IngestionSettings> {
    return requestJson(this.config, {
      method: "PUT",
      path: "/api/v1/settings/ingestion",
      body,
    });
  }

  reprocessWorkspaceIngestion(): Promise<WorkspaceIngestionReprocessResponse> {
    return requestJson(this.config, {
      method: "POST",
      path: "/api/v1/settings/ingestion/reprocess",
    });
  }

  getGeneralSettings(): Promise<GeneralSettingsResponse> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/settings/general",
    });
  }

  updateGeneralSettings(body: UpdateGeneralSettingsRequest): Promise<GeneralSettingsResponse> {
    return requestJson(this.config, {
      method: "PUT",
      path: "/api/v1/settings/general",
      body,
    });
  }

  listDocuments(query?: DocumentListQuery): Promise<DocumentListResponse> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/document/",
      query: query as Record<string, string | number | boolean | null | undefined> | undefined,
    });
  }

  createDocument(body: DocumentCreateRequest): Promise<DocumentOperationResponse> {
    return requestJson(this.config, {
      method: "POST",
      path: "/api/v1/document/",
      body,
    });
  }

  getDocument(documentId: string): Promise<DocumentDetails> {
    return requestJson(this.config, {
      method: "GET",
      path: `/api/v1/document/${documentId}`,
    });
  }

  updateDocument(documentId: string, body: UpdateDocumentRequest): Promise<DocumentOperationResponse> {
    return requestJson(this.config, {
      method: "PUT",
      path: `/api/v1/document/${documentId}`,
      body,
    });
  }

  deleteDocument(documentId: string): Promise<void> {
    return requestJson(this.config, {
      method: "DELETE",
      path: `/api/v1/document/${documentId}`,
    });
  }

  searchDocuments(body: DocumentSearchRequest): Promise<DocumentSearchResponse> {
    return requestJson(this.config, {
      method: "POST",
      path: "/api/v1/document/search",
      body,
    });
  }

  listDocumentSearchHistory(query?: PaginationQuery): Promise<DocumentSearchHistoryListResponse> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/document/search/history",
      query: query as Record<string, string | number | boolean | null | undefined> | undefined,
    });
  }

  getDocumentSearchHistory(searchId: string): Promise<DocumentSearchResponse> {
    return requestJson(this.config, {
      method: "GET",
      path: `/api/v1/document/search/history/${searchId}`,
    });
  }

  reprocessDocument(documentId: string): Promise<DocumentOperationResponse> {
    return requestJson(this.config, {
      method: "POST",
      path: `/api/v1/document/${documentId}/reprocess`,
    });
  }

  createChatResponse(body: ChatCreateRequest): Promise<ChatResponse> {
    return requestJson(this.config, {
      method: "POST",
      path: "/api/v1/chat/",
      body: {
        ...body,
        stream: false,
      },
    });
  }

  listChatHistory(query?: PaginationQuery): Promise<ChatHistoryListResponse> {
    return requestJson(this.config, {
      method: "GET",
      path: "/api/v1/chat/history",
      query: query as Record<string, string | number | boolean | null | undefined> | undefined,
    });
  }

  getChatHistoryConversation(conversationId: string, query?: PaginationQuery): Promise<ChatConversationDetail> {
    return requestJson(this.config, {
      method: "GET",
      path: `/api/v1/chat/history/${conversationId}`,
      query: query as Record<string, string | number | boolean | null | undefined> | undefined,
    });
  }
}
