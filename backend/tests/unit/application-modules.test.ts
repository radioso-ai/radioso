import { describe, expect, it, vi } from "vitest";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
  type ApplicationModule,
} from "../../src/app/composition/applicationModule.js";

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("application modules", () => {
  it("rejects duplicate module identifiers", async () => {
    const logger = createLogger();
    const coordinator = new ApplicationModuleCoordinator({
      logger,
      registry: createApplicationExtensionRegistry(),
    });
    const first: ApplicationModule = { id: "duplicate" };
    const second: ApplicationModule = { id: "duplicate" };

    expect(() => coordinator.apply([first, second])).toThrow(
      'Application module "duplicate" is already registered',
    );
  });

  it("applies module registrations and lifecycle hooks", async () => {
    const logger = createLogger();
    const registry = createApplicationExtensionRegistry();
    const initialize = vi.fn().mockResolvedValue(undefined);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const module: ApplicationModule = {
      id: "test-module",
      register(context) {
        context.registerCapabilityPolicy({
          async can() {
            return { allowed: true };
          },
        });
      },
      initialize,
      shutdown,
    };
    const coordinator = new ApplicationModuleCoordinator({ logger, registry });

    coordinator.apply([module]);
    await coordinator.initializeAll();
    await coordinator.shutdownAll();

    expect(registry.capabilityPolicy).toBeDefined();
    expect(initialize).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("logs initialization failures without losing the failing module id", async () => {
    const logger = createLogger();
    const registry = createApplicationExtensionRegistry();
    const coordinator = new ApplicationModuleCoordinator({ logger, registry });

    coordinator.apply([
      {
        id: "broken-module",
        async initialize() {
          throw new Error("missing configuration");
        },
      },
    ]);

    await expect(coordinator.initializeAll()).rejects.toThrow("missing configuration");
    expect(logger.error).toHaveBeenCalledWith(
      {
        moduleId: "broken-module",
        err: "missing configuration",
      },
      "Application module failed to initialize",
    );
  });

  it("collects multiple chat intake provider registrations into a list", () => {
    const logger = createLogger();
    const registry = createApplicationExtensionRegistry();
    const coordinator = new ApplicationModuleCoordinator({ logger, registry });

    const firstProvider = { handle: async () => null };
    const secondProvider = { handle: async () => null };

    coordinator.apply([
      {
        id: "first-module",
        register(context) {
          context.registerChatIntakeProvider(firstProvider);
        },
      },
      {
        id: "second-module",
        register(context) {
          context.registerChatIntakeProvider(secondProvider);
        },
      },
    ]);

    expect(registry.chatIntakeProviderRegistrations).toEqual([firstProvider, secondProvider]);
  });

  it("collects multiple skill executor registrations keyed by kind and adapter", () => {
    const logger = createLogger();
    const registry = createApplicationExtensionRegistry();
    const coordinator = new ApplicationModuleCoordinator({ logger, registry });

    const internalExecutor = {
      dispatch: async () => ({ disposition: "settled" as const, outcome: { status: "completed" as const, answer: "ok" } }),
    };
    const pipelineExecutor = {
      dispatch: async () => ({ disposition: "settled" as const, outcome: { status: "completed" as const, answer: "delivered" } }),
    };

    coordinator.apply([
      {
        id: "internal-executor-module",
        register(context) {
          context.registerSkillExecutor({
            kind: "internal",
            adapter: "echo",
            executor: internalExecutor,
          });
        },
      },
      {
        id: "pipeline-executor-module",
        register(context) {
          context.registerSkillExecutor({
            kind: "delivery_pipeline",
            adapter: "human_contact",
            executor: pipelineExecutor,
          });
        },
      },
    ]);

    expect(registry.skillExecutors).toHaveLength(2);
    expect(registry.skillExecutors[0]).toMatchObject({ kind: "internal", adapter: "echo" });
    expect(registry.skillExecutors[1]).toMatchObject({ kind: "delivery_pipeline", adapter: "human_contact" });
  });

  it("continues shutting down remaining modules when one shutdown hook fails", async () => {
    const logger = createLogger();
    const registry = createApplicationExtensionRegistry();
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const coordinator = new ApplicationModuleCoordinator({ logger, registry });

    coordinator.apply([
      {
        id: "first-module",
        shutdown,
      },
      {
        id: "broken-module",
        async shutdown() {
          throw new Error("shutdown failed");
        },
      },
    ]);

    await coordinator.shutdownAll();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      {
        moduleId: "broken-module",
        err: "shutdown failed",
      },
      "Application module failed to shut down",
    );
  });
});
