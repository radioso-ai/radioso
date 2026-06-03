import type { Router } from "express";

import type {
  SkillDefinition,
  SkillDisplayMetadata,
  SkillTurnStatus,
} from "@radioso/skill-contract";
import type {
  EmbeddingUsageEvent,
  ModelUsageEvent,
  UsageEventRecorder,
} from "@radioso/usage-contract";

export type { SkillDefinition, SkillDisplayMetadata, SkillTurnStatus };

export interface ApplicationModuleRegistrationContext {
  registerProductAnalyticsSink?(sink: ProductAnalyticsSink): void;
  registerErrorSink?(sink: ErrorSink): void;
  registerDatabaseMigrator(migrator: ApplicationDatabaseMigrator): void;
  registerRouteMount(mount: ApplicationRouteMount): void;
  registerUsageLimitPolicy(policy: ApplicationUsageLimitPolicyRegistration): void;
  registerUsageEventRecorder?(recorder: ApplicationUsageEventRecorderRegistration): void;
  registerAccountCreatedHandler(handler: ApplicationAccountCreatedHandler): void;
  registerChatIntakeProvider?(provider: ApplicationChatIntakeProviderRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
  registerAnswerFeedbackHistoryProvider(provider: ApplicationAnswerFeedbackHistoryProviderRegistration): void;
  registerSkillDefinition?(definition: SkillDefinition): void;
  registerAgentSurfaceExtension?(extension: AgentSurfaceExtension): void;
  registerChatActionSuggestionProvider?(provider: ApplicationChatActionSuggestionProviderRegistration): void;
}

/**
 * Mirrors OSS's `AgentSurfaceExtension` (in `backend/src/modules/agents/surfaceExtensions.ts`).
 * Kept structurally compatible so EE modules can implement and register the
 * extension without importing OSS types directly.
 */
export interface AgentSurfaceExtension<TSettings = unknown> {
  readonly key: string;
  defaults(): TSettings;
  normalize(input: unknown): TSettings;
  serialize(settings: TSettings): unknown;
  parse(raw: unknown): TSettings;
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

export interface ProductAnalyticsEvent {
  eventName: string;
  timestamp: string;
  workspaceId?: string;
  accountId?: string;
  actorType?: "operator" | "authenticated_user" | "anonymous_user" | "system";
  subjectType?: "workspace" | "document" | "conversation" | "settings" | "embed_session";
  subjectId?: string;
  properties?: Record<string, unknown>;
  source?: "backend" | "worker" | "frontend" | "embed";
}

export interface ProductAnalyticsSink {
  emit(event: ProductAnalyticsEvent): Promise<void>;
}

export type ErrorSeverity = "info" | "warn" | "error";

export interface ErrorEvent {
  errorType: string;
  timestamp: string;
  severity: ErrorSeverity;
  service: string;
  environment: string;
  version?: string;
  message: string;
  errorClass?: string;
  stack?: string;
  correlation?: Record<string, unknown>;
  requestContext?: {
    method?: string;
    route?: string;
    statusCode?: number;
  };
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface ErrorSink {
  record(event: ErrorEvent): Promise<void>;
}

// SkillDefinition, SkillDisplayMetadata, and SkillTurnStatus are imported
// from @radioso/skill-contract at the top of this file. The contract package
// owns the canonical shape so EE and OSS cannot drift.

export interface UsageLimitReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface IndexedStorageReservationInput {
  accountId?: string | null;
  workspaceId: string;
  contentSizeBytes: number;
  sourceKind?: string;
  externalDocumentId?: string | null;
}

export interface MonthlyIndexedContentReservationInput {
  accountId?: string | null;
  workspaceId: string;
  contentSizeBytes: number;
  sourceKind?: string;
  externalDocumentId?: string | null;
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
  reserveIndexedStorage(input: IndexedStorageReservationInput): Promise<UsageLimitReservation>;
  reserveMonthlyIndexedContent(input: MonthlyIndexedContentReservationInput): Promise<UsageLimitReservation>;
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
      APP_BASE_URL?: string;
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
      authenticateApiToken(token: string): Promise<{
        accountId: string;
        workspaceId: string;
        principal?: AuthenticatedPrincipal;
      }>;
    };
    accountAccessService: {
      requireActiveMembership(accountId: string, userId: string): Promise<void>;
      requirePermission(input: {
        accountId: string;
        userId?: string;
        principal?: AuthenticatedPrincipal;
        permission: WorkspaceRoutePermission;
        workspaceId?: string;
      }): Promise<void>;
    };
    workspaceSessionService: {
      resolve(input: { accountId: string; workspaceId?: string }): Promise<{ accountId: string; workspaceId: string }>;
    };
    userRepository: {
      findById(userId: string): Promise<{ email: string } | null>;
    };
    workspaceRepository: {
      findByAnonymousChatToken(token: string): Promise<{ id: string } | null>;
      findByWebsiteEmbedToken?(token: string): Promise<{ id: string } | null>;
    };
    agentRepository?: {
      findByAnonymousChatToken(token: string): Promise<{
        id: string;
        workspaceId: string;
        surfaceSettings: {
          anonymousChat: { enabled: boolean; token: string | null };
          websiteEmbed: { enabled: boolean; token: string | null };
        };
      } | null>;
      findByWebsiteEmbedToken(token: string): Promise<{
        id: string;
        workspaceId: string;
        surfaceSettings: {
          anonymousChat: { enabled: boolean; token: string | null };
          websiteEmbed: { enabled: boolean; token: string | null };
        };
      } | null>;
    };
    agentService?: AgentWizardAgentServicePort;
    ingestionSettingsService?: AgentWizardIngestionSettingsPort;
    documentStorage?: AgentWizardDocumentStoragePort;
    websiteCrawlJobService?: AgentWizardWebsiteCrawlerPort;
    chatTextGenerationClient?: AgentWizardTextGenerationPort;
    crawlerProvider?: AgentWizardCrawlerPort;
    assertPublicWebsiteUrl?: AgentWizardUrlPolicy;
    websiteCrawlerLimits?: AgentWizardCrawlerLimits;
    mailService: MailTransport;
  }): Router;
}

export type WorkspaceRoutePermission =
  | "workspace.settings.read"
  | "workspace.credentials.manage";

export type AuthenticatedPrincipal =
  | {
    type: "session_user";
    userId: string;
  }
  | {
    type: "workspace_api_token";
    role: "admin" | "member";
    tokenId?: string | null;
  };

export type AgentWizardUrlPolicy = (url: string) => Promise<void>;

export interface AgentWizardCrawlerLimits {
  defaultLimit: number;
  maxLimit: number;
}

export interface AgentWizardCrawlerPort {
  fetchPageWithScreenshot(
    url: string,
    options?: {
      signal?: AbortSignal;
      /**
       * Called before every top-level navigation request (including
       * redirects). Throw to abort. This is the SSRF gate: the wizard
       * service injects assertSafeUrl here so a public input URL that
       * redirects to localhost / RFC1918 / cloud metadata is rejected
       * before any request reaches the wire. Adapters MUST honor this.
       */
      validateNavigationUrl?: (url: string) => Promise<void> | void;
    },
  ): Promise<{
    url: string;
    title: string | null;
    text: string;
    links: string[];
    screenshot: Uint8Array | null;
    faviconUrl: string | null;
  }>;
  crawlSite(
    params: {
      baseUrl: string;
      pageLimit: number;
      seedPendingUrls?: string[];
      includeBaseUrl?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<Array<{
    url: string;
    title: string | null;
    text: string;
    status: string;
    links?: string[];
    httpStatus?: number | null;
    error?: string | null;
  }>>;
  isBrowserTransportAvailable(): Promise<boolean>;
}

export interface AgentWizardAgentServicePort {
  create(workspaceId: string, input: {
    name: string;
    customInstruction?: string;
    greetingInstruction?: string;
    retrievalEnabled?: boolean;
  }): Promise<{ id: string; name: string }>;
  update(workspaceId: string, agentId: string, input: Record<string, unknown>): Promise<{ id: string }>;
}

export interface AgentWizardIngestionSettingsPort {
  updateForWorkspace(workspaceId: string, input: {
    chunkingStrategy?: string;
    fixedWindowChunkSize?: number;
    fixedWindowChunkOverlap?: number;
    structuredMinChunkSize?: number;
    structuredMaxChunkSize?: number;
  }): Promise<void>;
}

export interface AgentWizardDocumentStoragePort {
  upload(input: {
    key: string;
    body: Uint8Array | NodeJS.ReadableStream;
    contentType: string;
  }): Promise<{ bucket: string; key: string; generation?: string | null }>;
}

export interface AgentWizardWebsiteCrawlerPort {
  enqueue(input: {
    accountId?: string | null;
    workspaceId: string;
    url: string;
    limit: number;
  }): Promise<{ jobId: string; sourceId: string | null }>;
}

export interface AgentWizardTextGenerationPort {
  complete(input: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<string>;
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

// The recorder contract is owned by @radioso/usage-contract (shared by OSS and
// EE). These aliases keep EE's local names stable while sourcing the canonical
// shapes from the contract so the two cannot drift.
export type RecordedEmbeddingEvent = EmbeddingUsageEvent;
export type RecordedModelCallEvent = ModelUsageEvent;
export type UsageEventRecorderPort = UsageEventRecorder;

export type ApplicationUsageEventRecorderRegistration =
  | UsageEventRecorderPort
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => UsageEventRecorderPort);

export type ActivityStageStatus = "applied" | "skipped" | "fallback" | "rejected" | "unavailable" | "failed";

export interface ActivityStage {
  stageId: string;
  kind: string;
  label: string;
  status: ActivityStageStatus;
  startedAt?: string;
  durationMs?: number;
  settings?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  metrics?: Record<string, number>;
  reason?: string;
}

export interface ActivityLink {
  fromStageId: string;
  toStageId: string;
  kind: "sequence" | "branch" | "converge";
}

export interface ActivitySummary {
  traceId?: string;
  skillName?: string;
  surface?: string;
  path?: string;
  status?: "success" | "skipped" | "blocked" | "failed" | "fallback" | "pending";
  outcome?: string;
  fallbackApplied?: boolean;
  primaryCounts?: Record<string, number>;
  contact?: Record<string, unknown>;
}

export interface ActivityTrace {
  traceId: string;
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  stages: ActivityStage[];
  links: ActivityLink[];
  summary?: ActivitySummary;
}

export interface ChatIntakeReceiptField {
  name: string;
  displayName: string;
  value: string;
}

export interface ChatIntakeReceipt {
  fields: ChatIntakeReceiptField[];
  statusLabel?: string;
}

export interface ChatIntakeResult {
  skillName: string;
  status: SkillTurnStatus;
  skillOutcome?: string;
  display?: SkillDisplayMetadata;
  stateId?: string;
  answer: string;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
  receipt?: ChatIntakeReceipt;
}

export interface PublicChatIntakeAction {
  skillName: string;
  intentName: string;
  display?: SkillDisplayMetadata;
}

export interface ChatInputIntentMetadata {
  skillName: string;
  intentName?: string;
}

export interface ChatInputMetadata {
  method: "typed" | "suggestion_click" | "intent_click";
  suggestionSourceMessageId?: string;
  intent?: ChatInputIntentMetadata;
}

export interface ChatIntakeProvider {
  handle(input: {
    workspaceId: string;
    accountId?: string | null;
    agentId?: string | null;
    conversationId: string;
    userMessageId: string;
    query: string;
    history: Array<{
      id: string;
      role: "user" | "assistant" | "system";
      content: string;
      createdAt: Date;
    }>;
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
    anonymousSessionId?: string | null;
    userExpectedLocale?: string | null;
    inputMetadata?: ChatInputMetadata;
  }): Promise<ChatIntakeResult | null>;
  getPublicIntakeActions?(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
  }): Promise<PublicChatIntakeAction[]>;
}

export interface ChatGateway {
  answer(input: { query: string; history: Array<{ role: string; content: string }>; prompt: string; systemPrompt?: string }): Promise<string>;
}

export type AssistantTurnOutcomeName =
  | "grounded_success"
  | "no_context_refusal"
  | "non_retrieval_response";

export interface ChatActionSuggestion {
  text: string;
  kind: string;
  citation?: {
    documentId: string;
    chunkId?: string;
    title: string;
  };
  action?:
    | { kind: "ask_followup" }
    | {
        kind: "start_intent";
        intent: {
          skillName: string;
          intentName?: string;
          display?: SkillDisplayMetadata;
        };
      };
}

export interface ChatActionSuggestionContext {
  workspaceId: string;
  conversationId: string;
  agentId?: string;
  query: string;
  answer: string;
  skillName: string;
  skillOutcome: string;
  skillStatus: SkillTurnStatus;
  answerOutcome?: AssistantTurnOutcomeName;
  history: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: Date;
  }>;
  userExpectedLocale?: string;
  sourceChannel?: string | null;
  sourceOrigin?: string | null;
}

export interface ChatActionSuggestionProvider {
  readonly name: string;
  evaluate(context: ChatActionSuggestionContext): Promise<ChatActionSuggestion | null>;
}

export type ApplicationChatActionSuggestionProviderRegistration =
  | ChatActionSuggestionProvider
  | ((context: {
      database: UsageLimitDatabasePort;
      chatGateway: ChatGateway;
      logger: {
        info?(entry: unknown, message?: string): void;
        warn?(entry: unknown, message?: string): void;
        error(entry: unknown, message?: string): void;
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
    }) => ChatActionSuggestionProvider);

export type ApplicationChatIntakeProviderRegistration =
  | ChatIntakeProvider
  | ((context: {
      database: UsageLimitDatabasePort;
      chatGateway: ChatGateway;
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
      workspaceContactInfoRepository: {
        findById(workspaceId: string): Promise<{
          id: string;
          name: string;
          publicRouteKey: string;
        } | null>;
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
      mailService: MailTransport;
      dashboardBaseUrl: string | null;
      assertPublicWebsiteUrl: AgentWizardUrlPolicy;
    }) => ChatIntakeProvider);

export interface MailTransport {
  send(message: {
    to: string;
    replyTo?: string | null;
    subject: string;
    text: string;
    html?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
}

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
  activitySummary?: ActivitySummary;
}

export interface ContactHistoryDetail extends ContactHistorySummary {
  message: string;
  finalDeliveryError: string | null;
  activityTrace?: ActivityTrace;
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

export interface AnswerFeedbackHistoryEntry {
  id: string;
  value: "up" | "down";
  comment: string | null;
  actorType: "authenticated_user" | "api_token" | "anonymous_user";
  actorId: string;
  accountId: string | null;
  userId: string | null;
  anonymousSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerFeedbackHistoryProvider {
  listByAssistantMessageIds(
    workspaceId: string,
    assistantMessageIds: string[],
  ): Promise<Map<string, AnswerFeedbackHistoryEntry[]>>;
}

export type ApplicationAnswerFeedbackHistoryProviderRegistration =
  | AnswerFeedbackHistoryProvider
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => AnswerFeedbackHistoryProvider);
