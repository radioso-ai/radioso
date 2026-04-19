import type { RadiosoMcpConfig } from "./config.js";
import type { DocumentListResult, JsonRecord, RetrievalSettingsRecord } from "./types.js";

export class RadiosoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RadiosoApiError";
  }
}

export interface RadiosoApiAdapter {
  listDocuments(query?: { limit?: number; cursor?: string; offset?: number }): Promise<DocumentListResult>;
  getDocument(documentId: string): Promise<unknown>;
  searchDocuments(body: { query: string; metadataFilter?: JsonRecord }): Promise<unknown>;
  answerGrounded(body: { query: string; conversationId?: string; metadataFilter?: Record<string, unknown> }): Promise<unknown>;
  getRetrievalSettings(): Promise<RetrievalSettingsRecord>;
  createDocument(body: {
    title: string;
    content: string;
    metadata?: JsonRecord;
    externalDocumentId?: string;
  }): Promise<unknown>;
  updateDocument(
    documentId: string,
    body: {
      title: string;
      content: string;
      metadata?: JsonRecord;
      externalDocumentId?: string;
    },
  ): Promise<unknown>;
  deleteDocument(documentId: string): Promise<void>;
  reprocessDocument(documentId: string): Promise<unknown>;
  updateRetrievalSettings(body: RetrievalSettingsRecord): Promise<unknown>;
}

type FetchLike = typeof fetch;

const readBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text.length > 0 ? text : undefined;
};

export const createRadiosoApiAdapter = (
  config: RadiosoMcpConfig,
  fetchImpl: FetchLike = fetch,
): RadiosoApiAdapter => {
  const request = async <TResult>(path: string, init: RequestInit = {}): Promise<TResult> => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.apiToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    const data = await readBody(response);

    if (!response.ok) {
      const errorPayload = data as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      throw new RadiosoApiError(
        errorPayload?.error?.message ?? `Radioso request failed with status ${response.status}`,
        response.status,
        errorPayload?.error?.code,
        errorPayload?.error?.details,
      );
    }

    return data as TResult;
  };

  return {
    answerGrounded: (body) =>
      request("/api/v1/chat", {
        body: JSON.stringify({ ...body, stream: false }),
        method: "POST",
      }),
    createDocument: (body) =>
      request("/api/v1/document", {
        body: JSON.stringify(body),
        method: "POST",
      }),
    deleteDocument: (documentId) =>
      request(`/api/v1/document/${documentId}`, {
        method: "DELETE",
      }),
    getDocument: (documentId) => request(`/api/v1/document/${documentId}`),
    getRetrievalSettings: () => request("/api/v1/settings/retrieval"),
    listDocuments: (query) => {
      const searchParams = new URLSearchParams();
      if (query?.limit !== undefined) searchParams.set("limit", String(query.limit));
      if (query?.cursor) searchParams.set("cursor", query.cursor);
      if (query?.offset !== undefined) searchParams.set("offset", String(query.offset));

      const suffix = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
      return request(`/api/v1/document${suffix}`);
    },
    reprocessDocument: (documentId) =>
      request(`/api/v1/document/${documentId}/reprocess`, {
        method: "POST",
      }),
    searchDocuments: (body) =>
      request("/api/v1/document/search", {
        body: JSON.stringify(body),
        method: "POST",
      }),
    updateDocument: (documentId, body) =>
      request(`/api/v1/document/${documentId}`, {
        body: JSON.stringify(body),
        method: "PUT",
      }),
    updateRetrievalSettings: (body) =>
      request("/api/v1/settings/retrieval", {
        body: JSON.stringify(body),
        method: "PUT",
      }),
  };
};
