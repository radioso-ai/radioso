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
