import type { DocumentInput } from "../import/buildDocuments.ts";

/** A document already stored in the target workspace (subset we read). */
export interface ExistingDocument {
  id: string;
  externalDocumentId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateResult {
  documentId: string;
  status: string;
}

/** Narrow port over the Radioso REST API — just what the importer needs. */
export interface RadiosoDocsClient {
  listAll(): Promise<ExistingDocument[]>;
  create(input: DocumentInput): Promise<CreateResult>;
  delete(documentId: string): Promise<void>;
}

export interface HttpClientConfig {
  baseUrl: string;
  apiToken: string;
  pageSize?: number;
}

export function createRadiosoDocsClient(config: HttpClientConfig): RadiosoDocsClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const pageSize = config.pageSize ?? 100;

  async function request(method: string, pathname: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${pathname} failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
    return response;
  }

  return {
    async listAll() {
      const documents: ExistingDocument[] = [];
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ limit: String(pageSize) });
        if (cursor) {
          query.set("cursor", cursor);
        }
        const response = await request("GET", `/api/v1/document/?${query.toString()}`);
        const page = (await response.json()) as {
          documents: ExistingDocument[];
          nextCursor?: string | null;
          hasMore?: boolean;
        };
        documents.push(...page.documents);
        cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      return documents;
    },

    async create(input) {
      const response = await request("POST", "/api/v1/document/", {
        title: input.title,
        content: input.content,
        metadata: input.metadata,
        externalDocumentId: input.externalDocumentId,
        source: input.source,
      });
      return (await response.json()) as CreateResult;
    },

    async delete(documentId) {
      await request("DELETE", `/api/v1/document/${documentId}`);
    },
  };
}
