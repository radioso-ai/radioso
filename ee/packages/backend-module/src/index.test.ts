import { describe, expect, it, vi } from "vitest";

import { createEnterpriseBackendModule } from "./index.js";
import type {
  ApplicationAccountCreatedHandler,
  ApplicationAnswerFeedbackHistoryProviderRegistration,
  ApplicationChatActionProviderRegistration,
  ApplicationContactHistoryProviderRegistration,
  ApplicationDatabaseMigrator,
  ApplicationModuleRegistrationContext,
  ApplicationRouteMount,
  ApplicationUsageLimitPolicyRegistration,
  WebsiteEmbedIntegrationProvider,
} from "./radiosoModuleTypes.js";

const createCaptureContext = () => {
  const databaseMigrators: ApplicationDatabaseMigrator[] = [];
  const routeMounts: ApplicationRouteMount[] = [];
  const accountCreatedHandlers: ApplicationAccountCreatedHandler[] = [];
  let usageLimitPolicy: ApplicationUsageLimitPolicyRegistration | undefined;
  let chatActionProvider: ApplicationChatActionProviderRegistration | undefined;
  let contactHistoryProvider: ApplicationContactHistoryProviderRegistration | undefined;
  let answerFeedbackHistoryProvider: ApplicationAnswerFeedbackHistoryProviderRegistration | undefined;
  let websiteEmbedIntegration: WebsiteEmbedIntegrationProvider | undefined;

  const context: ApplicationModuleRegistrationContext = {
    registerDatabaseMigrator(migrator) {
      databaseMigrators.push(migrator);
    },
    registerRouteMount(mount) {
      routeMounts.push(mount);
    },
    registerAccountCreatedHandler(handler) {
      accountCreatedHandlers.push(handler);
    },
    registerUsageLimitPolicy(policy) {
      usageLimitPolicy = policy;
    },
    registerChatActionProvider(provider) {
      chatActionProvider = provider;
    },
    registerContactHistoryProvider(provider) {
      contactHistoryProvider = provider;
    },
    registerAnswerFeedbackHistoryProvider(provider) {
      answerFeedbackHistoryProvider = provider;
    },
    registerWebsiteEmbedIntegration(provider) {
      websiteEmbedIntegration = provider;
    },
  };

  return {
    accountCreatedHandlers,
    context,
    databaseMigrators,
    get chatActionProvider() {
      return chatActionProvider;
    },
    get contactHistoryProvider() {
      return contactHistoryProvider;
    },
    get answerFeedbackHistoryProvider() {
      return answerFeedbackHistoryProvider;
    },
    get usageLimitPolicy() {
      return usageLimitPolicy;
    },
    get websiteEmbedIntegration() {
      return websiteEmbedIntegration;
    },
    routeMounts,
  };
};

describe("Enterprise backend module aggregation", () => {
  it("registers existing Enterprise contributions through feature modules", () => {
    const capture = createCaptureContext();
    const module = createEnterpriseBackendModule();

    module.register?.(capture.context);

    expect(module.id).toBe("radioso-enterprise-backend");
    expect(capture.databaseMigrators.map((migrator) => migrator.id).sort()).toEqual([
      "ee-assistant-answer-feedback",
      "ee-human-contact",
      "ee-mail-tokens",
      "ee-usage-limits",
    ]);
    expect(capture.routeMounts.map((mount) => mount.path).sort()).toEqual([
      "/api/v1/ee/answer-feedback",
      "/api/v1/ee/auth",
      "/api/v1/ee/contact",
      "/api/v1/ee/usage-limits",
    ]);
    expect(capture.accountCreatedHandlers).toHaveLength(1);
    expect(capture.usageLimitPolicy).toBeTypeOf("function");
    expect(capture.chatActionProvider).toBeTypeOf("function");
    expect(capture.contactHistoryProvider).toBeTypeOf("function");
    expect(capture.answerFeedbackHistoryProvider).toBeTypeOf("function");
    expect(capture.websiteEmbedIntegration).toBeDefined();
  });

  it("delegates shutdown to feature modules", async () => {
    const capture = createCaptureContext();
    const module = createEnterpriseBackendModule();
    module.register?.(capture.context);

    const providerFactory = capture.chatActionProvider;
    if (typeof providerFactory !== "function") {
      throw new Error("chat action provider factory was not registered");
    }
    const provider = providerFactory({
      abuseControlService: { enforce: vi.fn() },
      auditService: { record: vi.fn() },
      chatGateway: undefined,
      conversationRepository: {
        findByIdAndAnonymousSession: vi.fn(),
        findByIdAndWorkspaceId: vi.fn(),
      },
      database: { query: vi.fn().mockResolvedValue([]) },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      messageRepository: {
        listRecentByConversationId: vi.fn(),
      },
    } as any);
    const stopSpy = vi.spyOn(provider as any, "stop");

    await module.shutdown?.();

    expect(stopSpy).toHaveBeenCalledOnce();
  });
});
