import { createClientConfig, type RadiosoClientOptions } from "./core/config.js";
import { requestJson } from "./core/http.js";
import {
  GeneratedRadiosoClient,
  type ChatCreateRequest,
  type ChatStreamRequest,
  type DocumentOperationResponse,
  type SourceReprocessResponse,
  type WorkspaceIngestionReprocessResponse,
} from "./generated/client.js";
import { streamChat, type RadiosoChatStreamEvent } from "./streaming/chatStream.js";
import { createRoutinesResource } from "./resources/routines.js";
import { createDirectivesResource } from "./resources/directives.js";
import {
  createAgentContextVariablesResource,
  createContextVariablesResource,
} from "./resources/contextVariables.js";
import {
  createEmailSkillsResource,
  createExternalSkillsResource,
  createSkillsResource,
  createSlackSkillsResource,
  createWebhookSkillsResource,
} from "./resources/skills.js";
import { createMcpConnectionsResource, createMcpConverseGrantsResource } from "./resources/mcp.js";

export { RadiosoError } from "./core/errors.js";
export type {
  AssistantChatTurnRequest,
  AssistantChatRequest,
  AssistantChatResponse,
  ChatCreateRequest,
  ChatStreamRequest,
  ChatRequest,
  ChatResponse,
  Agent,
  ConversationAgent,
  ConversationAgentRequest,
  AgentListResponse,
  AgentSettings,
  AgentSettingsRequest,
  ChatConversationDetail,
  ChatHistoryListQuery,
  ChatHistoryListResponse,
  HistoryItemsResponse,
  DocumentCreateRequest,
  DocumentDetails,
  DocumentListResponse,
  DocumentOperationResponse,
  DocumentSearchRequest,
  DocumentSearchHistoryListResponse,
  DocumentSearchResponse,
  DocumentListQuery,
  GeneralSettingsResponse,
  IngestionSettings,
  PaginationQuery,
  RetrievalDefaultsResponse,
  SkillCatalogEntry,
  SkillCatalogResponse,
  UpdateDocumentRequest,
  UpdateGeneralSettingsRequest,
  UpdateIngestionSettingsRequest,
  WorkspaceSummaryResponse,
  WorkspaceIngestionReprocessResponse,
  DocumentReprocessRequest,
  SourceReprocessResponse,
  WebsiteCrawlRequest,
  WebsiteCrawlJobResponse,
  WebsiteCrawlJobStatus,
  WebsiteCrawlJobSummary,
  WebsiteCrawlJobListResponse,
  WebsiteCrawlJobListQuery,
} from "./generated/client.js";
export { DEFAULT_BASE_URL } from "./core/config.js";
export type { RadiosoClientOptions } from "./core/config.js";
export type {
  RadiosoChatStreamCancelledEvent,
  RadiosoChatStatusStage,
  RadiosoChatStreamEvent,
  RadiosoChatStreamStatusEvent,
} from "./streaming/chatStream.js";
export type {
  RoutineDefinitionListResponse,
  RoutineDefinitionGetResponse,
  RoutineDefinitionCreateRequest,
  RoutineDefinitionUpdateRequest,
  RoutineDefinitionSaveResponse,
  RoutineDefinitionLifecycleResponse,
  RoutineDefinitionPublishResponse,
  RoutineDefinitionValidateResponse,
  PortableRoutineDocumentEnvelope,
  PortableRoutineDocumentCreateResponse,
  RoutineDraftAssistRequest,
  RoutineDraftAssistResponse,
  RoutineSkillCatalogResponse,
} from "./resources/routines.js";
export type {
  DirectiveListResponse,
  DirectiveDraftRequest,
  DirectiveDraftResponse,
  AuthoredDirectiveCreateRequest,
  AuthoredDirectiveUpdateRequest,
  AuthoredDirectiveSaveResponse,
} from "./resources/directives.js";
export type {
  AgentContextVariableEnablementListResponse,
  AgentContextVariableEnablementRequest,
  AgentContextVariableEnablementResponse,
  ContextVariableSigningKeyResponse,
  ContextVariableListResponse,
  ContextVariableCreateRequest,
  ContextVariableUpdateRequest,
  ContextVariableResponse,
  ContextVariableValueUpsertRequest,
  ContextVariableValueDeleteRequest,
  ContextVariableValueResponse,
  ContextVariableValueScopeQuery,
} from "./resources/contextVariables.js";
export type {
  AgentSkillListResponse,
  AgentSkillCreateRequest,
  AgentSkillSaveResponse,
  AgentSkillUpdateRequest,
  AgentSkillCapabilitiesResponse,
  AgentEmailSkillListResponse,
  AgentEmailSkillCreateRequest,
  AgentEmailSkillResponse,
  AgentEmailSkillUpdateRequest,
  ExternalSkillListResponse,
  ExternalSkillCreateRequest,
  ExternalSkillResponse,
  ExternalSkillUpdateRequest,
  WebhookSkillListResponse,
  WebhookSkillCreateRequest,
  WebhookSkillResponse,
  WebhookSkillUpdateRequest,
  SlackSkillListResponse,
  SlackSkillCreateRequest,
  SlackSkillResponse,
  SlackSkillUpdateRequest,
} from "./resources/skills.js";
export type {
  McpConnectionListResponse,
  McpConnectionCreateRequest,
  McpConnectionResponse,
  McpConnectionUpdateRequest,
  McpConnectionDiscoverResponse,
  McpConnectionOauthStartResponse,
  McpConnectionOauthCompleteRequest,
  McpConnectionOauthCompleteResponse,
  AgentMcpConverseGrantListResponse,
  AgentMcpConverseGrantIssueRequest,
  AgentMcpConverseGrantIssueResponse,
  AgentMcpConverseGrantSecretResponse,
} from "./resources/mcp.js";

export interface DocumentImportFileRequest {
  file: Blob | Uint8Array | ArrayBuffer;
  filename?: string;
  title?: string;
  mimeType?: string;
}

export interface DocumentReprocessOptions {
  documentEnrichmentOverride?: "on" | "off";
}

const createUploadBlob = ({ file, mimeType }: DocumentImportFileRequest): Blob => {
  if (file instanceof Blob) {
    if (!mimeType || file.type === mimeType) {
      return file;
    }

    return new Blob([file], { type: mimeType });
  }

  if (file instanceof ArrayBuffer) {
    return new Blob([file], mimeType ? { type: mimeType } : undefined);
  }

  const copy = new ArrayBuffer(file.byteLength);
  new Uint8Array(copy).set(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
  return new Blob([copy], mimeType ? { type: mimeType } : undefined);
};

const resolveUploadFilename = ({ file, filename }: DocumentImportFileRequest): string => {
  if (filename) {
    return filename;
  }

  if (typeof File !== "undefined" && file instanceof File) {
    return file.name;
  }

  return "document";
};

export const createRadiosoClient = (options: RadiosoClientOptions) => {
  const config = createClientConfig(options);
  const generated = new GeneratedRadiosoClient(config);

  const routines = createRoutinesResource(config);
  const directives = createDirectivesResource(config);
  const agentContextVariables = createAgentContextVariablesResource(config);
  const contextVariables = createContextVariablesResource(config);
  const skills = createSkillsResource(config);
  const emailSkills = createEmailSkillsResource(config);
  const externalSkills = createExternalSkillsResource(config);
  const webhookSkills = createWebhookSkillsResource(config);
  const slackSkills = createSlackSkillsResource(config);
  const mcpConnections = createMcpConnectionsResource(config);
  const mcpConverseGrants = createMcpConverseGrantsResource(config);

  return {
    settings: {
      getRetrievalDefaults: () => generated.getRetrievalDefaults(),
      getIngestion: () => generated.getIngestionSettings(),
      updateIngestion: (body: Parameters<GeneratedRadiosoClient["updateIngestionSettings"]>[0]) =>
        generated.updateIngestionSettings(body),
      reprocessIngestion: (body?: DocumentReprocessOptions) =>
        requestJson<WorkspaceIngestionReprocessResponse>(config, {
          method: "POST",
          path: "/api/v1/settings/ingestion/reprocess",
          body,
        }),
      getGeneral: () => generated.getGeneralSettings(),
      updateGeneral: (body: Parameters<GeneratedRadiosoClient["updateGeneralSettings"]>[0]) =>
        generated.updateGeneralSettings(body),
    },
    workspace: {
      getSummary: () => generated.getWorkspaceSummary(),
    },
    skills: {
      list: () => generated.listSkills(),
      get: (skillName: string) => generated.getSkill(skillName),
    },
    agents: {
      list: () => generated.listAgents(),
      create: (body: Parameters<GeneratedRadiosoClient["createAgent"]>[0]) => generated.createAgent(body),
      get: (agentId: string) => generated.getAgent(agentId),
      update: (agentId: string, body: Parameters<GeneratedRadiosoClient["updateAgent"]>[1]) =>
        generated.updateAgent(agentId, body),
      setDefault: (agentId: string) => generated.setDefaultAgent(agentId),
      routines,
      directives,
      contextVariables: agentContextVariables,
      skills,
      emailSkills,
      externalSkills,
      webhookSkills,
      slackSkills,
      mcpConnections,
      mcpConverseGrants,
    },
    contextVariables,
    routines: {
      canonicalizePortable: routines.canonicalizePortable,
    },
    documents: {
      list: (query?: Parameters<GeneratedRadiosoClient["listDocuments"]>[0]) => generated.listDocuments(query),
      create: (body: Parameters<GeneratedRadiosoClient["createDocument"]>[0]) => generated.createDocument(body),
      importFile: (input: DocumentImportFileRequest) => {
        const formData = new FormData();
        formData.set("file", createUploadBlob(input), resolveUploadFilename(input));
        if (input.title) {
          formData.set("title", input.title);
        }

        return requestJson<DocumentOperationResponse>(config, {
          method: "POST",
          path: "/api/v1/document/import",
          body: formData,
        });
      },
      get: (documentId: string) => generated.getDocument(documentId),
      update: (documentId: string, body: Parameters<GeneratedRadiosoClient["updateDocument"]>[1]) =>
        generated.updateDocument(documentId, body),
      delete: (documentId: string) => generated.deleteDocument(documentId),
      search: (body: Parameters<GeneratedRadiosoClient["searchDocuments"]>[0]) => generated.searchDocuments(body),
      listHistory: (query?: Parameters<GeneratedRadiosoClient["listDocumentSearchHistory"]>[0]) =>
        generated.listDocumentSearchHistory(query),
      getHistory: (searchId: string) => generated.getDocumentSearchHistory(searchId),
      reprocess: (documentId: string, body?: DocumentReprocessOptions) =>
        requestJson<DocumentOperationResponse>(config, {
          method: "POST",
          path: `/api/v1/document/${encodeURIComponent(documentId)}/reprocess`,
          body,
        }),
      reprocessSource: (sourceId: string, body?: DocumentReprocessOptions) =>
        requestJson<SourceReprocessResponse>(config, {
          method: "POST",
          path: `/api/v1/document/sources/${encodeURIComponent(sourceId)}/reprocess`,
          body,
        }),
    },
    history: {
      list: (query?: Parameters<GeneratedRadiosoClient["listHistory"]>[0]) => generated.listHistory(query),
      listChats: (query?: Parameters<GeneratedRadiosoClient["listChatHistory"]>[0]) => generated.listChatHistory(query),
      listSearches: (query?: Parameters<GeneratedRadiosoClient["listHistorySearches"]>[0]) =>
        generated.listHistorySearches(query),
      getChat: (
        conversationId: string,
        query?: Parameters<GeneratedRadiosoClient["getChatHistoryConversation"]>[1],
      ) => generated.getChatHistoryConversation(conversationId, query),
      getSearch: (searchId: string) => generated.getHistorySearch(searchId),
    },
    chat: {
      create: (body: ChatCreateRequest) => {
        if ((body as { stream?: boolean }).stream === true) {
          throw new Error("chat.create() does not support stream=true. Use chat.stream() instead.");
        }

        return generated.createChatResponse(body);
      },
      listHistory: (query?: Parameters<GeneratedRadiosoClient["listChatHistory"]>[0]) => generated.listChatHistory(query),
      getHistoryConversation: (
        conversationId: string,
        query?: Parameters<GeneratedRadiosoClient["getChatHistoryConversation"]>[1],
      ) => generated.getChatHistoryConversation(conversationId, query),
      stream: (body: ChatStreamRequest): AsyncGenerator<RadiosoChatStreamEvent> => streamChat(config, body),
    },
  };
};
