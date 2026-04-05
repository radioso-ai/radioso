import type { InternalClientConfig } from "../core/config.js";
import { requestJson } from "../core/http.js";
import type { components } from "./types.js";

export type RetrievalSettings = components["schemas"]["RetrievalSettings"];
export type UpdateRetrievalSettingsRequest = components["schemas"]["UpdateRetrievalSettingsRequest"];
export type DocumentCreateRequest = components["schemas"]["DocumentCreateRequest"];
export type DocumentOperationResponse = components["schemas"]["DocumentOperationResponse"];
export type DocumentListResponse = components["schemas"]["DocumentListResponse"];
export type DocumentDetails = components["schemas"]["DocumentDetails"];
export type DocumentSearchRequest = components["schemas"]["DocumentSearchRequest"];
export type DocumentSearchResponse = components["schemas"]["DocumentSearchResponse"];
export type ChatRequest = components["schemas"]["ChatRequest"];
export type ChatResponse = components["schemas"]["ChatResponse"];
export type ChatCreateRequest = Omit<ChatRequest, "stream"> & { stream?: false };

export interface DocumentListQuery {
  limit?: number;
  offset?: number;
  cursor?: string;
}

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
}
