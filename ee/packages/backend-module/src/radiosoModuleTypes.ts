import type { Router } from "express";

export interface ApplicationModuleRegistrationContext {
  registerWebsiteEmbedIntegration(provider: WebsiteEmbedIntegrationProvider): void;
  registerDatabaseMigrator(migrator: ApplicationDatabaseMigrator): void;
  registerRouteMount(mount: ApplicationRouteMount): void;
  registerUsageLimitPolicy(policy: ApplicationUsageLimitPolicyRegistration): void;
  registerAccountCreatedHandler(handler: ApplicationAccountCreatedHandler): void;
  registerChatActionProvider(provider: ApplicationChatActionProviderRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
  registerSkillDefinition?(definition: SkillDefinition): void;
}

export type ApplicationAccountCreatedHandler = (context: {
  accountId: string;
  database: ApplicationDatabasePort;
  logger: {
    error(entry: unknown, message?: string): void;
  };
}) => Promise<void>;

export interface ApplicationModule {
  id: string;
  name?: string;
  register?(context: ApplicationModuleRegistrationContext): void;
  initialize?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface SkillDefinition {
  name: string;
  displayName: string;
  description: string;
  owner: "assistant" | "retrieval" | "documents" | "mcp" | "platform" | "auth" | "contact";
  executionClass: "interactive" | "deferred" | "administrative";
  supportedCallers: Array<"assistant" | "retrieval_api" | "sdk" | "mcp" | "dashboard" | "public_embed">;
  requiredCapabilities: string[];
  contractReferences: Array<{
    kind: "http" | "sdk" | "mcp_tool" | "documentation";
    label: string;
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
  }>;
  diagnostics: {
    defined: boolean;
    shapeAware: boolean;
    strategyAware: boolean;
    supportedFields?: string[];
  };
  steps: Array<{
    name: string;
    kind: string;
    displayName?: string;
    clauses: Record<string, unknown>;
  }>;
  shapes?: Array<{
    name: string;
    displayName?: string;
    description?: string;
    stepOverrides: Record<string, Record<string, unknown>>;
  }>;
}

export interface WebsiteEmbedIntegrationProvider {
  buildScriptUrl(): string | null;
  buildSnippet(workspace: WebsiteEmbedIntegrationWorkspace): string | null;
}

export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface UsageLimitPolicy {
  reserveAnswer(input: {
    accountId?: string | null;
    workspaceId: string;
    surface: string;
  }): Promise<UsageLimitReservation>;
  reserveDocument(input: {
    accountId?: string | null;
    workspaceId: string;
    sourceKind: string;
    externalDocumentId?: string | null;
  }): Promise<UsageLimitReservation>;
}

export interface ApplicationDatabasePort {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ApplicationDatabaseMigrator {
  id: string;
  migrate(database: ApplicationDatabasePort): Promise<void>;
}

export interface ApplicationRouteMount {
  path: string;
  createRouter(dependencies: {
    connectorDb: UsageLimitDatabasePort;
    env: {
      SESSION_COOKIE_NAME: string;
      PUBLIC_CHAT_SESSION_SECRET?: string;
      AUTH_RATE_LIMIT_WINDOW_MS?: number;
      AUTH_RATE_LIMIT_MAX_ATTEMPTS?: number;
    };
    abuseControlService: {
      enforce(input: {
        scope: string;
        subjectKey: string;
        limit: number;
        windowMs: number;
        blockMs?: number;
      }): Promise<unknown>;
    };
    auditService: {
      record(input: {
        accountId?: string | null;
        workspaceId?: string | null;
        eventType: string;
        eventStatus: "success" | "failure";
        metadata?: Record<string, unknown>;
      }): Promise<void>;
    };
    authService: {
      authenticateSession(token: string): Promise<{ accountId: string; userId: string; sessionId: string }>;
      authenticateApiToken(token: string): Promise<{ accountId: string; workspaceId: string }>;
    };
    accountAccessService: {
      requireActiveMembership(accountId: string, userId: string): Promise<void>;
    };
    workspaceSessionService: {
      resolve(input: { accountId: string; workspaceId?: string }): Promise<{ accountId: string; workspaceId: string }>;
    };
    userRepository: {
      findById(userId: string): Promise<{ email: string } | null>;
    };
    workspaceRepository: {
      findByAnonymousChatToken(token: string): Promise<{ id: string } | null>;
    };
    documentIngestionService?: {
      ingest(input: {
        accountId?: string | null;
        workspaceId: string;
        title: string;
        content: string;
        metadata?: Record<string, unknown>;
        externalDocumentId?: string | null;
      }): Promise<{ documentId: string; status: string }>;
    };
  }): Router;
}

export interface UsageLimitDatabaseClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[] | { rows: T[] }>;
}

export interface UsageLimitDatabasePort extends UsageLimitDatabaseClient {
  withTransaction?<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T>;
}

export type ApplicationUsageLimitPolicyRegistration =
  | UsageLimitPolicy
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => UsageLimitPolicy);

export interface ChatActionSuggestion {
  text: string;
  kind: string;
  action: {
    kind: string;
    payload?: Record<string, unknown>;
  };
}

export interface ChatActionProvider {
  evaluate(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    assistantMessageId: string;
    query: string;
    answer: string;
    answerOutcome: string;
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatActionSuggestion | null>;
  getPublicSessionActions?(input: { workspaceId: string }): Promise<Record<string, unknown> | null | undefined>;
}

export type ApplicationChatActionProviderRegistration =
  | ChatActionProvider
  | ((context: {
      database: UsageLimitDatabasePort;
      chatGateway?: unknown;
      logger: {
        info?(entry: unknown, message?: string): void;
        warn?(entry: unknown, message?: string): void;
        error(entry: unknown, message?: string): void;
      };
      conversationRepository: {
        findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
          id: string;
          workspaceId: string;
          sourceChannel: string | null;
          sourceOrigin: string | null;
          anonymousSessionId: string | null;
        } | null>;
        findByIdAndAnonymousSession(conversationId: string, workspaceId: string, anonymousSessionId: string): Promise<{
          id: string;
          workspaceId: string;
          sourceChannel: string | null;
          sourceOrigin: string | null;
          anonymousSessionId: string | null;
        } | null>;
      };
      messageRepository: {
        listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<Array<{
          id: string;
          role: "user" | "assistant" | "system";
          content: string;
          createdAt: Date;
        }>>;
      };
      auditService: {
        record(input: {
          accountId?: string | null;
          workspaceId?: string | null;
          eventType: string;
          eventStatus: "success" | "failure";
          metadata?: Record<string, unknown>;
        }): Promise<void>;
      };
      abuseControlService: {
        enforce(input: {
          scope: string;
          subjectKey: string;
          limit: number;
          windowMs: number;
          blockMs?: number;
        }): Promise<void>;
      };
    }) => ChatActionProvider);

export interface ContactHistorySummary {
  id: string;
  sortAt: string;
  workspaceId: string;
  conversationId: string;
  assistantMessageId: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  userEmail: string;
  messagePreview: string;
  triggerSource: string;
  triggerReason: string | null;
  status: "pending" | "delivering" | "delivered" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactHistoryDetail extends ContactHistorySummary {
  message: string;
  finalDeliveryError: string | null;
}

export interface ContactHistoryProvider {
  listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number },
  ): Promise<{
    contacts: ContactHistorySummary[];
    total: number;
    nextCursor: null;
    hasMore: boolean;
  }>;
  getById(workspaceId: string, requestId: string): Promise<ContactHistoryDetail | null>;
}

export type ApplicationContactHistoryProviderRegistration =
  | ContactHistoryProvider
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => ContactHistoryProvider);

export interface WebsiteEmbedIntegrationWorkspace {
  name: string;
  assistantName: string;
  websiteEmbedEnabled: boolean;
  websiteEmbedToken: string | null;
  websiteEmbedAllowedOrigins: string[];
  websiteEmbedLauncherLabel: string;
  websiteEmbedLauncherIcon: string;
  websiteEmbedLauncherPosition: string;
}
