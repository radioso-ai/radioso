import type { RadiosoMcpConfig } from "./config.js";
import type { components } from "./generated/openapiTypes.js";
import type {
  DocumentListResult,
  JsonRecord,
  RetrievalSettingsRecord,
  WorkspaceMcpContextRecord,
} from "./types.js";

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
  getWorkspaceMcpContext(): Promise<WorkspaceMcpContextRecord>;
  listDocuments(query?: { limit?: number; cursor?: string; offset?: number }): Promise<DocumentListResult>;
  getDocument(documentId: string): Promise<unknown>;
  searchDocuments(body: { query: string; metadataFilter?: JsonRecord }): Promise<unknown>;
  answerGrounded(body: {
    query: string;
    conversationContext?: {
      previousUserMessages?: string[];
      previousAssistantMessages?: string[];
      followUpToMessageId?: string;
    };
    metadataFilter?: Record<string, unknown>;
  }): Promise<unknown>;
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
type CapabilityErrorCode = "resource_not_found" | "unsupported_capability";

type PlatformSettingsRecord = components["schemas"]["PlatformSettingsResponse"];

interface RequestOptions {
  notFoundCode?: CapabilityErrorCode;
}

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
  config: Pick<RadiosoMcpConfig, "apiToken" | "baseUrl" | "requestTimeoutMs" | "serverName"> & {
    mcpSourceSigningSecret?: string;
  },
  fetchImpl: FetchLike = fetch,
): RadiosoApiAdapter => {
  const request = async <TResult>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<TResult> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response: Response;

    try {
      response = await fetchImpl(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiToken}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
        signal: init.signal ?? controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new RadiosoApiError(
          `Radioso request timed out after ${config.requestTimeoutMs}ms`,
          504,
          "upstream_timeout",
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const data = await readBody(response);

    if (!response.ok) {
      const errorPayload = data as { error?: { code?: string; message?: string; details?: unknown } } | undefined;
      const code = response.status === 404
        ? options.notFoundCode ?? errorPayload?.error?.code ?? "resource_not_found"
        : errorPayload?.error?.code;
      throw new RadiosoApiError(
        errorPayload?.error?.message ?? `Radioso request failed with status ${response.status}`,
        response.status,
        code,
        errorPayload?.error?.details,
      );
    }

    return data as TResult;
  };

  const toRetrievalSettings = (settings: PlatformSettingsRecord): RetrievalSettingsRecord => ({
    ...settings.retrieval,
    suggestedQuestionsEnabled: settings.assistant.suggestedQuestionsEnabled,
    customInstruction: settings.assistant.customInstruction,
  });

  return {
    answerGrounded: (body) =>
      request("/api/v1/retrieval/answer", {
        // MCP tool responses intentionally retain Radioso retrieval diagnostics for operator inspection.
        body: JSON.stringify({ ...body, includeDebug: true }),
        headers: {
          "x-radioso-capability-client": "mcp",
        },
        method: "POST",
      }, { notFoundCode: "unsupported_capability" }),
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
    getRetrievalSettings: async () => toRetrievalSettings(
      await request<PlatformSettingsRecord>("/api/v1/settings", {}, { notFoundCode: "unsupported_capability" }),
    ),
    getWorkspaceMcpContext: () =>
      request("/api/v1/workspace/mcp/context", {}, { notFoundCode: "unsupported_capability" }),
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
        // MCP tool responses intentionally retain Radioso retrieval diagnostics for operator inspection.
        body: JSON.stringify({ ...body, includeDebug: true }),
        headers: {
          "x-radioso-capability-client": "mcp",
        },
        method: "POST",
      }, { notFoundCode: "unsupported_capability" }),
    updateDocument: (documentId, body) =>
      request(`/api/v1/document/${documentId}`, {
        body: JSON.stringify(body),
        method: "PUT",
      }),
    updateRetrievalSettings: (body) =>
      request("/api/v1/settings", {
        body: JSON.stringify({
          assistant: {
            suggestedQuestionsEnabled: body.suggestedQuestionsEnabled,
            customInstruction: body.customInstruction,
          },
          retrieval: {
            queryRewriteEnabled: body.queryRewriteEnabled,
            semanticRewriteInstructions: body.semanticRewriteInstructions,
            lexicalRewriteInstructions: body.lexicalRewriteInstructions,
            rerankEnabled: body.rerankEnabled,
            vectorTopK: body.vectorTopK,
            similarityThreshold: body.similarityThreshold,
            rerankTopK: body.rerankTopK,
            citationDisplayEnabled: body.citationDisplayEnabled,
            metadataRules: body.metadataRules,
          },
        }),
        method: "PUT",
      }, { notFoundCode: "unsupported_capability" }),
  };
};
