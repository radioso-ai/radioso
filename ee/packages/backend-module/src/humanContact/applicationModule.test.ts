import { describe, expect, it, vi } from "vitest";

import { createHumanContactApplicationModule } from "./applicationModule.js";
import type {
  ApplicationChatIntakeProviderRegistration,
  ApplicationDatabaseMigrator,
  ApplicationModuleRegistrationContext,
  SkillDefinition,
} from "../radiosoModuleTypes.js";

const createChatIntakeDependencies = () => ({
  abuseControlService: { enforce: vi.fn() },
  auditService: { record: vi.fn() },
  chatGateway: {
    answer: vi.fn().mockResolvedValue("{}"),
  },
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
  workspaceContactInfoRepository: {
    findById: vi.fn(),
  },
  mailService: {
    sendHumanContactRequestEmail: vi.fn(),
  },
  dashboardBaseUrl: null,
});

describe("human contact application module", () => {
  it("registers the human contact request skill definition when installed", () => {
    const registeredSkills: SkillDefinition[] = [];
    const registeredMigrators: ApplicationDatabaseMigrator[] = [];
    const module = createHumanContactApplicationModule();

    module.register?.({
      registerDatabaseMigrator(migrator) {
        registeredMigrators.push(migrator);
      },
      registerSkillDefinition(definition) {
        registeredSkills.push(definition);
      },
      registerChatIntakeProvider: vi.fn(),
      registerContactHistoryProvider: vi.fn(),
      registerRouteMount: vi.fn(),
      registerWebsiteEmbedIntegration: vi.fn(),
      registerUsageLimitPolicy: vi.fn(),
      registerAccountCreatedHandler: vi.fn(),
    } satisfies ApplicationModuleRegistrationContext);

    expect(registeredMigrators.map((migrator) => migrator.id)).toEqual([
      "ee-skill-submissions",
      "ee-human-contact",
    ]);
    expect(registeredSkills).toEqual([
      expect.objectContaining({
        name: "human_contact.request",
        owner: "contact",
        diagnostics: expect.objectContaining({
          defined: true,
          shapeAware: true,
          strategyAware: false,
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({ name: "availability_check" }),
          expect.objectContaining({ name: "trigger_evaluation" }),
          expect.objectContaining({ name: "delivery_dispatch" }),
        ]),
        intake: expect.objectContaining({
          enabled: true,
          subjectIdentityField: "email",
          fields: expect.arrayContaining([
            expect.objectContaining({ name: "email", type: "email", required: true }),
            expect.objectContaining({ name: "message", type: "string", required: true }),
          ]),
        }),
        execution: expect.objectContaining({
          kind: "delivery_pipeline",
          adapter: "human_contact",
          destinations: ["email", "webhook"],
          enqueue: true,
        }),
      }),
    ]);
  });

  it("stops the internal runtime on shutdown without exposing lifecycle on providers", async () => {
    const stop = vi.fn();
    const state = {
      service: {
        stop,
      } as any,
    };
    const module = createHumanContactApplicationModule(state);

    await module.shutdown?.();

    expect(stop).toHaveBeenCalledOnce();
    expect(state.service).toBeNull();
  });

  it("recreates the internal runtime when chat intake is built with new dependencies", async () => {
    const stop = vi.fn();
    const previousService = {
      stop,
    };
    const state = {
      service: previousService as any,
    };
    let providerFactory: ApplicationChatIntakeProviderRegistration | undefined;
    const module = createHumanContactApplicationModule(state);

    module.register?.({
      registerDatabaseMigrator: vi.fn(),
      registerSkillDefinition: vi.fn(),
      registerChatIntakeProvider(provider) {
        providerFactory = provider;
      },
      registerContactHistoryProvider: vi.fn(),
      registerRouteMount: vi.fn(),
      registerWebsiteEmbedIntegration: vi.fn(),
      registerUsageLimitPolicy: vi.fn(),
      registerAccountCreatedHandler: vi.fn(),
    } satisfies ApplicationModuleRegistrationContext);

    if (typeof providerFactory !== "function") {
      throw new Error("chat intake provider factory was not registered");
    }
    const provider = providerFactory(createChatIntakeDependencies());

    expect(stop).toHaveBeenCalledOnce();
    expect(provider).toEqual({
      handle: expect.any(Function),
      getPublicIntakeActions: expect.any(Function),
    });
    expect(state.service).not.toBe(previousService);

    await module.shutdown?.();
  });
});
