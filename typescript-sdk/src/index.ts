import { createClientConfig, type RadiosoClientOptions } from "./core/config.js";
import { GeneratedRadiosoClient, type ChatCreateRequest, type ChatRequest } from "./generated/client.js";
import { streamChat, type RadiosoChatStreamEvent } from "./streaming/chatStream.js";

export { RadiosoError } from "./core/errors.js";
export type {
  ChatCreateRequest,
  ChatRequest,
  ChatResponse,
  DocumentCreateRequest,
  DocumentDetails,
  DocumentListResponse,
  DocumentOperationResponse,
  DocumentSearchRequest,
  DocumentSearchResponse,
  DocumentListQuery,
  RetrievalSettings,
  UpdateDocumentRequest,
  UpdateRetrievalSettingsRequest,
} from "./generated/client.js";
export type { RadiosoClientOptions } from "./core/config.js";
export type { RadiosoChatStreamEvent } from "./streaming/chatStream.js";

export const createRadiosoClient = (options: RadiosoClientOptions) => {
  const config = createClientConfig(options);
  const generated = new GeneratedRadiosoClient(config);

  return {
    settings: {
      getRetrieval: () => generated.getRetrievalSettings(),
      updateRetrieval: (body: Parameters<GeneratedRadiosoClient["updateRetrievalSettings"]>[0]) =>
        generated.updateRetrievalSettings(body),
    },
    documents: {
      list: (query?: Parameters<GeneratedRadiosoClient["listDocuments"]>[0]) => generated.listDocuments(query),
      create: (body: Parameters<GeneratedRadiosoClient["createDocument"]>[0]) => generated.createDocument(body),
      get: (documentId: string) => generated.getDocument(documentId),
      update: (documentId: string, body: Parameters<GeneratedRadiosoClient["updateDocument"]>[1]) =>
        generated.updateDocument(documentId, body),
      delete: (documentId: string) => generated.deleteDocument(documentId),
      search: (body: Parameters<GeneratedRadiosoClient["searchDocuments"]>[0]) => generated.searchDocuments(body),
    },
    chat: {
      create: (body: ChatCreateRequest) => {
        if ((body as { stream?: boolean }).stream === true) {
          throw new Error("chat.create() does not support stream=true. Use chat.stream() instead.");
        }

        return generated.createChatResponse(body);
      },
      stream: (body: Omit<ChatRequest, "stream">): AsyncGenerator<RadiosoChatStreamEvent> => streamChat(config, body),
    },
  };
};
