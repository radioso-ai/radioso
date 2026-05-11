import type {
  DocumentPublicationEnvelope,
  DocumentPublisher,
  DocumentPublisherResult
} from "../types.js";

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const parseJsonSafely = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const createHttpDocumentPublisher = (input: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  treatDeleteNotFoundAsSuccess?: boolean;
}): DocumentPublisher => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const defaultHeaders = {
    "content-type": "application/json",
    ...input.headers
  };
  const treatDeleteNotFoundAsSuccess = input.treatDeleteNotFoundAsSuccess ?? true;

  return {
    upsert: async (document: DocumentPublicationEnvelope): Promise<DocumentPublisherResult> => {
      const response = await fetchImpl(joinUrl(input.baseUrl, "/documents"), {
        method: "POST",
        headers: defaultHeaders,
        body: JSON.stringify(document)
      });
      if (!response.ok) {
        throw new Error(`Document upsert failed with status ${response.status}`);
      }
      const payload = (await parseJsonSafely(response)) as
        | { documentId?: string; status?: DocumentPublisherResult["status"] }
        | null;
      return {
        documentId: payload?.documentId ?? document.externalId,
        status: payload?.status ?? "received"
      };
    },
    remove: async ({ externalId }: { externalId: string }) => {
      const response = await fetchImpl(
        joinUrl(input.baseUrl, `/documents/${encodeURIComponent(externalId)}`),
        {
          method: "DELETE",
          headers: input.headers
        }
      );
      if (!response.ok && !(treatDeleteNotFoundAsSuccess && response.status === 404)) {
        throw new Error(`Document delete failed with status ${response.status}`);
      }
    }
  };
};
