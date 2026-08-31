import type { RequestHandler, Router } from "express";
import type { Pool } from "pg";
import type { ZodType } from "zod";

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
  registerOrganizationCreationGuard?(guard: ApplicationOrganizationCreationGuardRegistration): void;
  registerUsageEventRecorder?(recorder: ApplicationUsageEventRecorderRegistration): void;
  registerAccountCreatedHandler(handler: ApplicationAccountCreatedHandler): void;
  registerPublicChatActionAdvertiser?(provider: ApplicationPublicChatActionAdvertiserRegistration): void;
  registerContactHistoryProvider(provider: ApplicationContactHistoryProviderRegistration): void;
  registerAnswerFeedbackHistoryProvider(provider: ApplicationAnswerFeedbackHistoryProviderRegistration): void;
  registerSkillDefinition?(definition: SkillDefinition): void;
  registerAgentSurfaceExtension?(extension: AgentSurfaceExtension): void;
  registerChatActionSuggestionProvider?(provider: ApplicationChatActionSuggestionProviderRegistration): void;
  registerCopilotTools?(registration: ApplicationCopilotToolRegistration): void;
}

/**
 * Mirrors OSS's operator-copilot catalog contract (in
 * `backend/src/modules/operatorCopilot/contracts.ts` and `contribution.ts`). Kept structurally
 * compatible so EE modules can contribute Ray tools without importing OSS types directly, the same
 * arrangement `AgentSurfaceExtension` above uses.
 *
 * Reads, probes, and acts only. A `propose` tool needs an adapter for its target type, and the
 * target-type set is closed by an OpenAPI enum, repository narrowing, and the dashboard's card
 * presentation.
 */
export type CopilotToolShape = "read" | "probe" | "act" | "propose";

/**
 * The subset of OSS's `CopilotToolInvocationContext` an EE descriptor reads. OSS passes the full
 * context; declaring only what is used keeps the mirror small and the drift surface narrow.
 */
export interface CopilotToolInvocationContext {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
}

export interface CopilotAgentToolContext {
  readonly signal: AbortSignal;
  readonly stepIndex: number;
  readonly callId: string;
}

export interface CopilotAgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  invoke(input: TInput, context: CopilotAgentToolContext): Promise<TOutput>;
}

export interface CopilotEntityReference {
  readonly type: string;
  readonly id?: string;
  readonly label?: string;
  readonly agentId?: string;
}

export interface CopilotCapabilityProvenance {
  readonly backingOperationIds?: readonly [string, ...string[]];
  readonly applicationPrimitiveIds?: readonly [string, ...string[]];
  readonly rayOnly?: { readonly reason: string };
}

export interface CopilotToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly shape: CopilotToolShape;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  /** Workspace permissions, every one required. OSS resolves them per turn and filters on them. */
  readonly requiredPermissions: readonly [string, ...string[]];
  readonly capabilityProvenance: CopilotCapabilityProvenance;
  readonly contributingModule: string;
  readonly dashboardSubject: CopilotEntityReference;
  createTool(context: CopilotToolInvocationContext): CopilotAgentTool<TInput, TOutput>;
}

/**
 * Descriptors plus the identities their provenance cites. OSS validates provenance against its own
 * OpenAPI document and application-primitive registry, neither of which describes an EE surface, so
 * a contribution declares its own operations and primitives instead.
 */
export interface CopilotToolContribution {
  readonly moduleId: string;
  readonly descriptors: ReadonlyArray<CopilotToolDescriptor>;
  /** Operation id -> the workspace permissions that operation's own HTTP route requires. */
  readonly operationPermissions?: Readonly<Record<string, readonly string[]>>;
  readonly applicationPrimitives?: Readonly<Record<string, { readonly owningModule: string; readonly exportedPort: string }>>;
}

export type ApplicationCopilotToolRegistration =
  | CopilotToolContribution
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
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
    }) => CopilotToolContribution);

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
  // The OSS `Database` instance is passed here at runtime; it carries both the
  // `query` escape hatch and the `pool` EE builds its Kysely from. Typed as the
  // full port so EE handlers can construct data-access services.
  database: UsageLimitDatabasePort;
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

export type OrganizationCoreProvisioningRequest =
  | {
      intent: "new_user";
      organizationName: string;
      email: string;
      passwordHash: string;
      emailVerifiedAt: Date | null;
    }
  | {
      intent: "existing_user";
      userId: string;
      organizationName: string;
      email: string;
      passwordHash: string;
    };

export interface OrganizationCoreProvisioningResult {
  account: { id: string; name: string };
  userId: string;
  workspace: { id: string; name: string; publicRouteKey: string };
}

export interface OrganizationCoreProvisioner {
  provision(input: OrganizationCoreProvisioningRequest): Promise<OrganizationCoreProvisioningResult>;
}

export interface OrganizationCreationReservation {
  coreProvisioner?: OrganizationCoreProvisioner;
  commit(input: { accountId: string }): Promise<void>;
  release(): Promise<void>;
}

export type OrganizationCreationRequest =
  | { intent: "signup" }
  | { intent: "additional"; userId: string };

export interface OrganizationCreationGuard {
  reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation>;
  isSignupAvailable(): Promise<boolean>;
}

export interface ApplicationDatabasePort {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface ApplicationDatabaseMigrator {
  id: string;
  migrate(database: ApplicationDatabasePort): Promise<void>;
}

export type ApiPrincipalAuthenticationMode = "machine_eligible" | "machine_required" | "session_only";

/** Narrow host capability for marking optional-module authentication in the central route inventory. */
export interface ApiPrincipalRouteInventory {
  markAuthenticator<T extends RequestHandler>(handler: T, mode: ApiPrincipalAuthenticationMode): T;
  markRouteMount<T extends Router>(router: T, path: string): T;
}

export interface ApplicationRouteMount {
  path: string;
  createRouter(dependencies: {
    connectorDb: UsageLimitDatabasePort;
    env: {
      SESSION_COOKIE_NAME: string;
      STAFF_SESSION_COOKIE_NAME?: string;
      STAFF_SESSION_TTL_HOURS?: number;
      APP_BASE_URL?: string;
      PUBLIC_CHAT_SESSION_SECRET?: string;
      AUTH_RATE_LIMIT_WINDOW_MS?: number;
      AUTH_RATE_LIMIT_MAX_ATTEMPTS?: number;
    };
    apiPrincipalRouteInventory: ApiPrincipalRouteInventory;
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
      // Provider-agnostic federated sign-in. EE modules translate their
      // provider response (e.g. Google OAuth) into this verified-identity
      // assertion; OSS owns account provisioning + session issuance and never
      // learns about the specific provider.
      federatedLogin(input: {
        provider: string;
        subject: string;
        email: string;
        emailVerified: boolean;
      }): Promise<{
        userId: string;
        accountId: string;
        organizationName: string;
        workspaceId: string;
        workspaceName: string;
        workspacePublicRouteKey: string;
        sessionCookie: string;
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

export interface WizardAnalysisResult {
  suggestedName: string;
  suggestedCustomInstruction: string;
  suggestedGreetingMessage: string;
  suggestedChunkingStrategy: {
    strategy: "fixed_window" | "structured_semantic";
    reasoning: string;
  };
  screenshotBase64: string | null;
  screenshotUnavailableReason: string | null;
  faviconUrl: string | null;
  pagesAnalyzed: Array<{ url: string; title: string | null }>;
  sourceUrl: string;
  suggestedLocale: string | null;
  suggestedPrivacyPolicyUrl: string | null;
  suggestedContactEmail: string | null;
}

export interface WizardCreateInput {
  websiteUrl: string;
  name: string;
  customInstruction?: string;
  greetingInstruction?: string;
  chunkingStrategy?: "fixed_window" | "structured_semantic";
  faviconUrl?: string | null;
  assistantDefaultLocale?: string | null;
  privacyPolicyUrl?: string | null;
  contactEmail?: string | null;
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
  // The underlying connection pool, owned by the OSS `Database` that is handed
  // to EE's registration callbacks. EE builds its own self-contained Kysely on
  // this pool (see `db/eeSchema.ts`) for data access, while `query` remains for
  // the DDL migrator. EE never owns or closes this pool.
  pool: Pool;
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

export type ApplicationOrganizationCreationGuardRegistration =
  | OrganizationCreationGuard
  | ((context: {
      database: UsageLimitDatabasePort;
      logger: {
        error(entry: unknown, message?: string): void;
      };
    }) => OrganizationCreationGuard);

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

export interface PublicChatActionAdvertiser {
  getPublicIntakeActions(input: {
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

export type ApplicationPublicChatActionAdvertiserRegistration =
  | PublicChatActionAdvertiser
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
    }) => PublicChatActionAdvertiser);

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
