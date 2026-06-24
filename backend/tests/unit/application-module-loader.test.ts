import { describe, expect, it, vi } from "vitest";

import {
  loadConfiguredApplicationModules,
  resolveConfiguredApplicationModuleSpecifiers,
} from "../../src/runtime/loadApplicationModules.js";

describe("application module loader", () => {
  it("uses the Enterprise backend module as the default for Enterprise runtimes", () => {
    expect(resolveConfiguredApplicationModuleSpecifiers({
      RADIOSO_APPLICATION_MODULES: undefined,
      RADIOSO_EDITION: "enterprise",
    })).toEqual(["@radioso/enterprise-backend-module"]);
  });

  it("keeps explicit application modules authoritative for Enterprise runtimes", () => {
    expect(resolveConfiguredApplicationModuleSpecifiers({
      RADIOSO_APPLICATION_MODULES: "custom-one, custom-two",
      RADIOSO_EDITION: "enterprise",
    })).toEqual(["custom-one", "custom-two"]);
  });

  it("loads application modules from configured module specifiers", async () => {
    const logger = createLogger();
    const moduleSpecifier = new URL("../fixtures/application-module.fixture.mjs", import.meta.url).href;

    const modules = await loadConfiguredApplicationModules({
      NODE_ENV: "test",
      RADIOSO_APPLICATION_MODULES: moduleSpecifier,
      RADIOSO_EDITION: "oss",
    }, logger);

    expect(modules.map((module) => module.id)).toEqual(["enterprise-module"]);
    expect(logger.info).toHaveBeenCalledWith(
      {
        moduleSpecifier,
        moduleIds: ["enterprise-module"],
      },
      "Loaded Radioso application module",
    );
  });

  it("deduplicates modules exported by both name and default", async () => {
    const logger = createLogger();
    const moduleSpecifier = new URL("../fixtures/application-module.fixture.mjs", import.meta.url).href;

    const modules = await loadConfiguredApplicationModules({
      NODE_ENV: "test",
      RADIOSO_APPLICATION_MODULES: `${moduleSpecifier},${moduleSpecifier}`,
      RADIOSO_EDITION: "oss",
    }, logger);

    expect(modules.map((module) => module.id)).toEqual(["enterprise-module"]);
  });

  it("skips missing configured modules in development", async () => {
    const logger = createLogger();

    const modules = await loadConfiguredApplicationModules({
      NODE_ENV: "development",
      RADIOSO_APPLICATION_MODULES: "@radioso/missing-application-module",
      RADIOSO_EDITION: "oss",
    }, logger);

    expect(modules).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        moduleSpecifier: "@radioso/missing-application-module",
        error: expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }),
      }),
      "Skipping missing Radioso application module in development",
    );
  });

  it("throws missing configured modules outside development", async () => {
    const logger = createLogger();

    await expect(loadConfiguredApplicationModules({
      NODE_ENV: "production",
      RADIOSO_APPLICATION_MODULES: "@radioso/missing-application-module",
      RADIOSO_EDITION: "oss",
    }, logger)).rejects.toMatchObject({ code: "ERR_MODULE_NOT_FOUND" });
  });
});

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});
